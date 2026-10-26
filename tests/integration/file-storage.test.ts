// File storage against Azurite and PostgreSQL (ats-project-scope.md F2, F4,
// F5, V11; tech-stack.md §8): private blobs, signed links and their expiry,
// storePdf with rollback, and the file-link API with real sessions (T5).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as getFileUrl } from "@/app/api/files/[id]/url/route";
import { FILES_CONTAINER, getStorage } from "@/server/adapters/storage";
import { connectionStringBlobEndpoint } from "@/server/adapters/storage/endpoints";
import { getConfig } from "@/server/config";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { files, settings } from "@/server/db/schema";
import { PdfRejectedError, storePdf } from "@/server/files/store-pdf";
import { rolledBack } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

const VALID_PDF = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));

function blobUrl(key: string): string {
  const storage = getConfig().storage;
  if (storage.mode !== "connectionString") throw new Error("integration tests run against Azurite");
  return `${connectionStringBlobEndpoint(storage.connectionString)}/${FILES_CONTAINER}/${key}`;
}

function storeIn(tx: Tx, bytes = VALID_PDF) {
  return storePdf(tx, { ownerType: "APPLICATION", ownerId: randomUUID(), kind: "CV", originalName: "Synthetic CV.pdf", bytes });
}

/** A committed CLEAN file row with its blob. */
function committedFile() {
  return withTransaction((tx) => storeIn(tx));
}

describe("StorageService on Azurite", () => {
  it("F4: a blob can't be read or listed anonymously, only through a signed link", async () => {
    const { key } = await getStorage().upload(VALID_PDF, "application/pdf");
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    expect((await fetch(blobUrl(key))).ok).toBe(false);
    const listing = await fetch(`${blobUrl("").slice(0, -1)}?restype=container&comp=list`);
    expect(listing.ok).toBe(false);
    expect([403, 404]).toContain(listing.status);

    const { url } = await getStorage().getSignedUrl(key);
    expect((await fetch(url)).status).toBe(200);
  });

  it("F5: a signed link returns the PDF with Content-Type application/pdf and Content-Disposition inline", async () => {
    const { key } = await getStorage().upload(VALID_PDF, "application/pdf");
    const response = await fetch((await getStorage().getSignedUrl(key)).url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(VALID_PDF);
  });

  it("V11: a link expires 300 s after it is issued", async () => {
    const { key } = await getStorage().upload(VALID_PDF, "application/pdf");
    const before = Date.now();
    const { expiresAt } = await getStorage().getSignedUrl(key);
    expect(Math.abs(expiresAt.getTime() - (before + 300_000))).toBeLessThan(5_000);
  });

  it("V11: a link issued 6 minutes ago has expired and returns 403, without sleeping", async () => {
    const { key } = await getStorage().upload(VALID_PDF, "application/pdf");
    const { url } = await getStorage().getSignedUrl(key, { now: new Date(Date.now() - 6 * 60_000) });
    expect((await fetch(url)).status).toBe(403);
  });

  it("V11: a signed link is read-only: a PUT returns 403", async () => {
    const { key } = await getStorage().upload(VALID_PDF, "application/pdf");
    const { url } = await getStorage().getSignedUrl(key);
    const response = await fetch(url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: "overwritten" });
    expect(response.status).toBe(403);
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(VALID_PDF);
  });

  it("delete is idempotent and the blob is gone afterwards", async () => {
    const storage = getStorage();
    const { key } = await storage.upload(VALID_PDF, "application/pdf");
    await storage.delete(key);
    await storage.delete(key);
    expect((await fetch((await storage.getSignedUrl(key)).url)).status).toBe(404);
  });

  it("download returns the stored bytes", async () => {
    const { key } = await getStorage().upload(VALID_PDF, "application/pdf");
    expect(new Uint8Array(await getStorage().download(key))).toEqual(VALID_PDF);
  });

  it("checkHealth passes when the files container exists", async () => {
    await expect(getStorage().checkHealth()).resolves.toBeUndefined();
  });
});

describe("storePdf", () => {
  it("F4: stores the blob under a random key and records the files row", async () => {
    const row = await committedFile();
    expect(row).toMatchObject({ mime: "application/pdf", sizeBytes: VALID_PDF.length, originalName: "Synthetic CV.pdf", status: "CLEAN" });
    expect(row.storageKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.storageKey).not.toContain("CV");
    const response = await fetch((await getStorage().getSignedUrl(row.storageKey)).url);
    expect(response.status).toBe(200);
  });

  it("deletes the blob when the transaction rolls back, leaving no row", async () => {
    let stored: { id: string; storageKey: string } | undefined;
    await rolledBack(async (tx) => {
      stored = await storeIn(tx);
    });
    expect(await getDb().select().from(files).where(eq(files.id, stored!.id))).toEqual([]);
    expect((await fetch((await getStorage().getSignedUrl(stored!.storageKey)).url)).status).toBe(404);
  });

  it("F2: with MAX_UPLOAD_MB = 1, a 2 MiB PDF is rejected with TOO_LARGE", async () => {
    await rolledBack(async (tx) => {
      await tx.insert(settings).values({ key: "MAX_UPLOAD_MB", value: "1" });
      const twoMiB = new Uint8Array(2 * 1_048_576);
      twoMiB.set(VALID_PDF);
      const error = await storeIn(tx, twoMiB).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(PdfRejectedError);
      expect(error).toMatchObject({ code: "TOO_LARGE", maxMb: 1 });
    });
  });

  it("F3: rejects an encrypted PDF before uploading anything", async () => {
    await rolledBack(async (tx) => {
      const encrypted = new Uint8Array(readFileSync("tests/fixtures/pdf/permissions-only.pdf"));
      await expect(storeIn(tx, encrypted)).rejects.toMatchObject({ code: "ENCRYPTED" });
      expect(await tx.select().from(files)).toEqual(expect.not.arrayContaining([expect.objectContaining({ sizeBytes: encrypted.length })]));
    });
  });
});

describe("GET /api/files/[id]/url", () => {
  async function call(id: string, cookie?: string) {
    const request = new Request(`${ORIGIN}/api/files/${id}/url`, { headers: cookie ? { cookie } : {} });
    return getFileUrl(request, { params: Promise.resolve({ id }) });
  }

  it("V11: a Recruiter gets a 5-minute link that opens the PDF, with Cache-Control no-store", async () => {
    const file = await committedFile();
    const before = Date.now();
    const response = await call(file.id, (await signedIn("RECRUITER")).cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { url: string; expiresAt: string };
    expect(Math.abs(Date.parse(body.expiresAt) - (before + 300_000))).toBeLessThan(5_000);
    const pdf = await fetch(body.url);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
  });

  it("V11: an Admin gets a link too", async () => {
    const file = await committedFile();
    expect((await call(file.id, (await signedIn("ADMIN")).cookie)).status).toBe(200);
  });

  // Since task 34 these roles can view files of applications in their scope
  // (V4, V5); outside it a file is a single record they can't see: 404 (V9).
  it("V11, V9: a Hiring Manager and an Interviewer outside the file's application get 404 and no URL", async () => {
    const file = await committedFile();
    for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
      const response = await call(file.id, (await signedIn(role)).cookie);
      expect(response.status, role).toBe(404);
      const text = await response.text();
      expect(text).not.toContain("http");
      expect(text).not.toContain("sig=");
    }
  });

  it("V11: no session gets 401", async () => {
    const file = await committedFile();
    expect((await call(file.id)).status).toBe(401);
  });

  it("V11: an unknown, malformed, deleted or non-CLEAN file is 404", async () => {
    const { cookie } = await signedIn("RECRUITER");
    const deleted = await committedFile();
    await getDb().update(files).set({ deletedAt: new Date() }).where(eq(files.id, deleted.id));
    const scanning = await committedFile();
    await getDb().update(files).set({ status: "PENDING_SCAN" }).where(eq(files.id, scanning.id));

    for (const id of [randomUUID(), "not-a-uuid", deleted.id, scanning.id]) {
      const response = await call(id, cookie);
      expect(response.status, id).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
});

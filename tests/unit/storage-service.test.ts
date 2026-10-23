// StorageService signing without a network (tech-stack.md §8, F5, V11): the
// Azurite mode signs with the account key locally; the Azure mode runs
// against a mocked client to show the user delegation key is cached.
import { describe, expect, it, vi } from "vitest";
import { createStorageService } from "@/server/adapters/storage";

const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const COMPOSE_CONNECTION_STRING = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${AZURITE_KEY};BlobEndpoint=http://azurite:10000/devstoreaccount1;`;
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";

function sasParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

/** A BlobServiceClient stand-in for the managed-identity mode. */
function mockedAzureClient() {
  const getUserDelegationKey = vi.fn(async (startsOn: Date, expiresOn: Date) => ({
    signedObjectId: "00000000-0000-0000-0000-000000000001",
    signedTenantId: "00000000-0000-0000-0000-000000000002",
    signedStartsOn: startsOn,
    signedExpiresOn: expiresOn,
    signedService: "b",
    signedVersion: "2025-01-05",
    value: Buffer.from("delegation-key-secret").toString("base64"),
  }));
  const client = { accountName: "atsdemo", getContainerClient: () => ({}), getUserDelegationKey };
  return { client, getUserDelegationKey };
}

describe("StorageService signed links", () => {
  it("V11: a link expires 300 s after it is issued by default", async () => {
    const storage = createStorageService({ mode: "connectionString", connectionString: COMPOSE_CONNECTION_STRING, publicUrl: undefined });
    const now = new Date("2026-10-23T10:00:00Z");
    const { url, expiresAt } = await storage.getSignedUrl(KEY, { now });
    expect(expiresAt.toISOString()).toBe("2026-10-23T10:05:00.000Z");
    expect(sasParams(url).get("se")).toBe("2026-10-23T10:05:00Z");
  });

  it("F5: the Azurite SAS is blob-scoped, read-only, without a start time, and opens the PDF inline", async () => {
    const storage = createStorageService({
      mode: "connectionString",
      connectionString: COMPOSE_CONNECTION_STRING,
      publicUrl: "http://localhost:10000/devstoreaccount1/",
    });
    const { url } = await storage.getSignedUrl(KEY);
    expect(url.startsWith(`http://localhost:10000/devstoreaccount1/files/${KEY}?`)).toBe(true);
    const sas = sasParams(url);
    expect(sas.get("sr")).toBe("b");
    expect(sas.get("sp")).toBe("r");
    expect(sas.has("st")).toBe(false);
    expect(sas.get("rsct")).toBe("application/pdf");
    expect(sas.get("rscd")).toBe("inline");
    expect(sas.get("sig")).toBeTruthy();
  });

  it("uses the connection-string endpoint when no public URL is set", async () => {
    const storage = createStorageService({ mode: "connectionString", connectionString: COMPOSE_CONNECTION_STRING, publicUrl: undefined });
    expect((await storage.getSignedUrl(KEY)).url.startsWith(`http://azurite:10000/devstoreaccount1/files/${KEY}?`)).toBe(true);
  });

  it("F5: the Azure SAS is signed with a user delegation key, HTTPS only, with the same shape", async () => {
    const { client } = mockedAzureClient();
    const storage = createStorageService(
      { mode: "managedIdentity", accountUrl: "https://atsdemo.blob.core.windows.net", clientId: "client-id" },
      { client: client as never },
    );
    const { url } = await storage.getSignedUrl(KEY);
    expect(url.startsWith(`https://atsdemo.blob.core.windows.net/files/${KEY}?`)).toBe(true);
    const sas = sasParams(url);
    expect(sas.get("spr")).toBe("https");
    expect(sas.get("skoid")).toBe("00000000-0000-0000-0000-000000000001");
    expect(sas.get("sr")).toBe("b");
    expect(sas.get("sp")).toBe("r");
    expect(sas.has("st")).toBe(false);
    expect(sas.get("rsct")).toBe("application/pdf");
    expect(sas.get("rscd")).toBe("inline");
  });

  it("caches the user delegation key: two links request one key, a fresh one near expiry", async () => {
    const { client, getUserDelegationKey } = mockedAzureClient();
    const storage = createStorageService(
      { mode: "managedIdentity", accountUrl: "https://atsdemo.blob.core.windows.net", clientId: "client-id" },
      { client: client as never },
    );
    await Promise.all([storage.getSignedUrl(KEY), storage.getSignedUrl(KEY)]);
    await storage.getSignedUrl(KEY);
    expect(getUserDelegationKey).toHaveBeenCalledOnce();

    // The key lives one hour; within five minutes of its expiry a new one is requested.
    vi.useFakeTimers({ now: Date.now() + 56 * 60_000 });
    try {
      await storage.getSignedUrl(KEY);
      expect(getUserDelegationKey).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a connection string without an account key", () => {
    expect(() =>
      createStorageService({ mode: "connectionString", connectionString: "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;SharedAccessSignature=sv=x", publicUrl: undefined }),
    ).toThrow("account key");
  });
});

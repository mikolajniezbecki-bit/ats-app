// Upload validation (ats-project-scope.md F1–F3) with the committed synthetic
// fixtures in tests/fixtures/pdf. The 5 MiB boundary files are derived from
// valid.pdf at run time instead of committing two 5 MiB files: PDF readers
// skip `%` comment lines after the end-of-file marker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BYTES_PER_MB, validatePdfUpload } from "@/server/files/validate-pdf";
import messages from "../../messages/en.json";

const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/pdf/${name}`));
const FIVE_MIB = 5 * BYTES_PER_MB;
const limit = { maxBytes: FIVE_MIB };

/** valid.pdf padded with a trailing comment to exactly `size` bytes. */
function validPdfOfSize(size: number): Uint8Array {
  const base = fixture("valid.pdf");
  const padding = new Uint8Array(size - base.length).fill(0x20);
  padding[0] = 0x0a; // newline
  padding[1] = 0x25; // "%"
  const bytes = new Uint8Array(size);
  bytes.set(base);
  bytes.set(padding, base.length);
  return bytes;
}

describe("validatePdfUpload", () => {
  it("F1: accepts a valid PDF", async () => {
    expect(await validatePdfUpload(fixture("valid.pdf"), limit)).toEqual({ ok: true });
  });

  it("F1: rejects a PNG renamed to .pdf as NOT_PDF", async () => {
    expect(await validatePdfUpload(fixture("png-renamed.pdf"), limit)).toEqual({ ok: false, code: "NOT_PDF" });
  });

  it("F3: requires the %PDF- signature at byte 0 (a leading space is NOT_PDF)", async () => {
    expect(await validatePdfUpload(fixture("leading-space.pdf"), limit)).toEqual({ ok: false, code: "NOT_PDF" });
  });

  it("F2: accepts exactly MAX_UPLOAD_MB MiB and rejects one byte more as TOO_LARGE", async () => {
    const exact = validPdfOfSize(FIVE_MIB);
    expect(exact.length).toBe(5_242_880);
    expect(await validatePdfUpload(exact, limit)).toEqual({ ok: true });
    expect(await validatePdfUpload(validPdfOfSize(FIVE_MIB + 1), limit)).toEqual({ ok: false, code: "TOO_LARGE" });
  });

  it("F2: rejects an empty file as EMPTY", async () => {
    expect(await validatePdfUpload(fixture("empty.pdf"), limit)).toEqual({ ok: false, code: "EMPTY" });
  });

  it("F3: rejects a user-password PDF and a permissions-only PDF as ENCRYPTED", async () => {
    expect(await validatePdfUpload(fixture("user-password.pdf"), limit)).toEqual({ ok: false, code: "ENCRYPTED" });
    expect(await validatePdfUpload(fixture("permissions-only.pdf"), limit)).toEqual({ ok: false, code: "ENCRYPTED" });
  });

  it("F3: rejects a truncated PDF as DAMAGED", async () => {
    expect(await validatePdfUpload(fixture("truncated.pdf"), limit)).toEqual({ ok: false, code: "DAMAGED" });
  });

  it("F2: checks the size before the content", async () => {
    const big = new Uint8Array(FIVE_MIB + 1);
    expect(await validatePdfUpload(big, limit)).toEqual({ ok: false, code: "TOO_LARGE" });
  });

  it("has a message for every rejection code", () => {
    expect(messages.Files.errors).toEqual({
      EMPTY: "The file is empty.",
      TOO_LARGE: "The file is larger than {max} MB.",
      NOT_PDF: "Only PDF files are accepted.",
      ENCRYPTED: "Encrypted or password-protected PDFs are not accepted.",
      DAMAGED: "The PDF file can't be read.",
    });
  });
});

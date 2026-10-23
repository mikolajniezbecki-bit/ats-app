// Upload validation (ats-project-scope.md F1–F3). Content decides: the file
// name, extension and browser-sent MIME type are ignored. No framework
// imports, so it runs anywhere the bytes are.
import { EncryptedPDFError, PDFDocument } from "pdf-lib";

/** 1 MB = 1 MiB (F2). */
export const BYTES_PER_MB = 1_048_576;

export type PdfRejection = "EMPTY" | "TOO_LARGE" | "NOT_PDF" | "ENCRYPTED" | "DAMAGED";

export type PdfValidation = { ok: true } | { ok: false; code: PdfRejection };

const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ENCRYPT_TOKEN = Buffer.from("/Encrypt");

/**
 * Checks, in this order: size (F2), the `%PDF-` signature at byte 0 (F1, F3),
 * then a full parse that refuses any encryption, including permissions-only
 * PDFs, and any file that can't be parsed (F3).
 */
export async function validatePdfUpload(bytes: Uint8Array, { maxBytes }: { maxBytes: number }): Promise<PdfValidation> {
  if (bytes.length === 0) return { ok: false, code: "EMPTY" };
  if (bytes.length > maxBytes) return { ok: false, code: "TOO_LARGE" };
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) return { ok: false, code: "NOT_PDF" };

  try {
    const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false });
    // Walks the page tree, so a document without a usable catalog fails here.
    document.getPageCount();
    return { ok: true };
  } catch (err) {
    if (err instanceof EncryptedPDFError) return { ok: false, code: "ENCRYPTED" };
    // An encrypted file can also fail to parse before pdf-lib reaches its
    // trailer; it is still refused as encrypted rather than damaged.
    return { ok: false, code: Buffer.from(bytes).includes(ENCRYPT_TOKEN) ? "ENCRYPTED" : "DAMAGED" };
  }
}

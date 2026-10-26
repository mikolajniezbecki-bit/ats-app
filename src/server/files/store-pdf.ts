// Stores a validated PDF (ats-project-scope.md F1–F4): the blob goes to
// private storage under a random key, the `files` row into the caller's
// transaction. If that transaction rolls back, the blob is deleted again.
import { type Tx, onRollback } from "../db";
import { files } from "../db/schema";
import { getStorage } from "../adapters/storage";
import { logger } from "../logger";
import { getSetting } from "../settings";
import { BYTES_PER_MB, type PdfRejection, validatePdfUpload } from "./validate-pdf";

type FileRow = typeof files.$inferSelect;

export type StorePdfInput = {
  ownerType: FileRow["ownerType"];
  ownerId: string;
  kind: FileRow["kind"];
  /** The uploaded file name; personal data, stored only in the database (RT4). */
  originalName: string | null;
  bytes: Uint8Array;
  /**
   * Generated files (the P7 offer letter, task 37 Q4) skip the F2
   * `MAX_UPLOAD_MB` limit, which is about uploads; all other checks apply.
   */
  generated?: boolean;
};

/** A refused upload; `code` maps to its `Files.errors` message. */
export class PdfRejectedError extends Error {
  override name = "PdfRejectedError";
  constructor(
    readonly code: PdfRejection,
    readonly maxMb: number,
  ) {
    super(`PDF rejected: ${code}`);
  }
}

/** The upload limit in bytes: `MAX_UPLOAD_MB` MiB (F2). */
export async function maxUploadBytes(tx?: Tx): Promise<{ maxMb: number; maxBytes: number }> {
  const maxMb = await getSetting("MAX_UPLOAD_MB", tx);
  return { maxMb, maxBytes: maxMb * BYTES_PER_MB };
}

/** Validates, uploads and records the file in `tx`; throws PdfRejectedError for an invalid file. */
export async function storePdf(tx: Tx, input: StorePdfInput): Promise<FileRow> {
  const { maxMb, maxBytes } = await maxUploadBytes(tx);
  const validation = await validatePdfUpload(input.bytes, { maxBytes: input.generated ? Number.POSITIVE_INFINITY : maxBytes });
  if (!validation.ok) throw new PdfRejectedError(validation.code, maxMb);

  const storage = getStorage();
  const { key } = await storage.upload(input.bytes, "application/pdf");
  // Registered before the insert, so a failed insert also removes the blob.
  onRollback(tx, async () => {
    try {
      await storage.delete(key);
    } catch (err) {
      logger.warn({ storage_key: key, err: { message: (err as Error).message } }, "orphaned blob not deleted");
    }
  });

  const [row] = await tx
    .insert(files)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      kind: input.kind,
      mime: "application/pdf",
      sizeBytes: input.bytes.length,
      originalName: input.originalName,
      storageKey: key,
      status: "CLEAN",
    })
    .returning();
  logger.info({ file_id: row.id }, "file stored");
  return row;
}

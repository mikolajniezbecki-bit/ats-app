// Optimistic locking (tech-stack.md D7): updates to the versioned tables
// carry the version the user saw and fail if someone else changed the row
// since. R9 shows the same message in the UI.
import { and, eq, getTableName, sql } from "drizzle-orm";
import type { Tx } from "./index";
import { applications, offers, requisitions } from "./schema";

/** Shown to the user when their update is based on a stale version (D7, R9). */
export const STALE_RECORD_MESSAGE = "This record was changed by someone else. Reload and try again.";

export class StaleRecordError extends Error {
  constructor() {
    super(STALE_RECORD_MESSAGE);
    this.name = "StaleRecordError";
  }
}

export class RecordNotFoundError extends Error {
  constructor(table: string, id: string) {
    super(`No ${table} row with id ${id}`);
    this.name = "RecordNotFoundError";
  }
}

/** The tables with a `version` column (§7). */
export type VersionedTable = typeof applications | typeof requisitions | typeof offers;

/** Columns a caller may change; the helper owns the key, version and timestamps. */
export type VersionedChanges<T extends VersionedTable> = Omit<
  Partial<T["$inferInsert"]>,
  "id" | "version" | "createdAt" | "updatedAt"
>;

const MANAGED_KEYS = ["id", "version", "createdAt", "updatedAt"];

/**
 * Runs one `UPDATE … SET …, version = version + 1, updated_at = now()
 * WHERE id = :id AND version = :expectedVersion RETURNING *` and returns the
 * updated row. Throws StaleRecordError when the row exists with another
 * version, RecordNotFoundError when it doesn't exist.
 */
export async function updateWithVersion<T extends VersionedTable>(
  tx: Tx,
  table: T,
  id: string,
  expectedVersion: number,
  changes: VersionedChanges<T>,
): Promise<T["$inferSelect"]> {
  const managed = MANAGED_KEYS.filter((key) => key in changes);
  if (managed.length > 0) {
    throw new Error(`updateWithVersion sets ${managed.join(", ")} itself; remove them from the changes`);
  }

  // The three tables share id/version, but Drizzle can't type a query over a
  // union of tables, so the query is built against one of them.
  const t = table as typeof applications;
  const [row] = await tx
    .update(t)
    .set({ ...(changes as VersionedChanges<typeof applications>), version: sql`${t.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(t.id, id), eq(t.version, expectedVersion)))
    .returning();
  if (row) return row as T["$inferSelect"];

  const [existing] = await tx.select({ id: t.id }).from(t).where(eq(t.id, id));
  if (existing) throw new StaleRecordError();
  throw new RecordNotFoundError(getTableName(table), id);
}


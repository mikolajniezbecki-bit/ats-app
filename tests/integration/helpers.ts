// Helpers for constraint tests. Every test works inside a transaction that is
// rolled back, so rows never leak into other tests sharing the worker database
// (T2), even for constraints with a small value space such as the partial
// unique index on templates.trigger_status.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { type Tx, withTransaction } from "@/server/db";
import { rootCause } from "@/server/db/migrator";

class RollBack extends Error {}

/** Runs `fn(tx)` and always rolls the transaction back. */
export async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(
    withTransaction(async (tx) => {
      await fn(tx);
      throw new RollBack();
    }),
  ).rejects.toBeInstanceOf(RollBack);
}

/**
 * Expects `fn` to fail with this PostgreSQL error code and constraint. It runs
 * in a savepoint, so the surrounding transaction stays usable.
 */
export async function expectPgError(
  tx: Tx,
  fn: (sp: Tx) => Promise<unknown>,
  expected: { code: string; constraint: string },
): Promise<void> {
  const error = await tx.transaction(fn).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error, `expected ${expected.constraint} to reject the statement`).toBeDefined();
  const cause = rootCause(error) as { code?: string; constraint?: string };
  expect({ code: cause.code, constraint: cause.constraint }).toEqual(expected);
}

export const PG = {
  uniqueViolation: "23505",
  checkViolation: "23514",
} as const;

/** A value no other test uses. */
export function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

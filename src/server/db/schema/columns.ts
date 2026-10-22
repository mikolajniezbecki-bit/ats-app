// Shared column and constraint builders for the ats-project-scope.md §7
// conventions. Schema files import only drizzle-orm and each other (no `@/`
// aliases, no `server-only`), because drizzle-kit loads them on its own.
import { type AnyPgColumn, check, timestamp, uuid } from "drizzle-orm/pg-core";
import { type SQL, sql } from "drizzle-orm";

/** `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` */
export const id = () => uuid("id").primaryKey().defaultRandom();

/**
 * `created_at` / `updated_at` on every table (§7). `updated_at` is set by
 * Drizzle on every update; raw SQL updates must set it themselves.
 */
export const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * `CHECK (column IN (...))` for a text enumeration. Drizzle's `text({ enum })`
 * only types the column, so every enumeration also declares this check. The
 * values are compile-time constants, rendered as SQL literals because DDL
 * takes no parameters.
 */
export function enumCheck(name: string, column: AnyPgColumn, values: readonly string[]) {
  const list = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return check(name, sql`${column} IN (${sql.raw(list)})` as SQL);
}

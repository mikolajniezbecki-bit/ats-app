// Authentication tables (tech-stack.md AU10; ats-project-scope.md §7
// "Authentication tables"). Owned by Better Auth, which reads and writes them
// through the Drizzle adapter by these property names. Generated with the
// Better Auth CLI, then adjusted to §7: snake_case columns, UUID keys,
// created_at/updated_at, indexed foreign keys to users.id, and no
// ON DELETE CASCADE (the CLI's default).
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./administration";
import { id, timestamps } from "./columns";

export const session = pgTable(
  "session",
  {
    id: id(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique("session_token_unique"),
    // Always null: IP tracking is off (§3 rule 9 forbids the first
    // x-forwarded-for entry Better Auth would store).
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

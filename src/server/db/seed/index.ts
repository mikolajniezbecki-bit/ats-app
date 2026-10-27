// `db:seed` (tech-stack.md D8): settings defaults, master data, templates and
// the four demo users, in one transaction. Idempotent and non-destructive:
// records are inserted only when missing by natural key and never updated,
// so an Admin's changes survive a rerun. Demo users get a dev password only
// when AUTH_DEV_LOGIN=true (AU7); a rerun updates it. Then, only while no
// requisition exists, the synthetic demo data (task 42) in the same
// transaction and under the same advisory lock; its uploaded files are
// deleted again when the transaction fails. Output is counts only (M2): in
// Azure the db-seed job's stdout goes to Log Analytics.
import { and, eq, sql } from "drizzle-orm";
import { type StorageService, getStorage } from "../../adapters/storage";
import { setDevPassword } from "../../auth/dev-passwords";
import { logger } from "../../logger";
import type { AppConfig } from "../../config";
import { SETTING_DEFINITIONS, SETTING_KEYS } from "../../settings";
import type { Db, Tx } from "../index";
import { auditLog, masterData, settings, templates, users } from "../schema";
import { SEED_DEMO_USERS, SEED_MASTER_DATA, SEED_TEMPLATES } from "./data";
import { type SyntheticCounts, seedSynthetic } from "./synthetic";

export class SeedError extends Error {
  override name = "SeedError";
}

export type SeedCounts = Record<"settings" | "masterData" | "templates" | "users", { inserted: number; skipped: number }> & {
  passwordsSet: number;
  /** Absent when the synthetic step was turned off (`synthetic: false`). */
  synthetic?: SyntheticCounts;
};

/** `synthetic: false` runs the base seed only; `storage` and `now` are for tests. */
export type SeedOptions = { synthetic?: boolean; storage?: StorageService; now?: Date };

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Checks what the seed needs before it writes anything. */
export function seedPreconditions(config: AppConfig): { domain: string; password: string | undefined; warnings: string[] } {
  const domain = config.demoUser.domain?.toLowerCase();
  if (!domain || !DOMAIN.test(domain)) throw new SeedError("DEMO_USER_DOMAIN must be set to a valid domain, e.g. ats-demo.local.");
  const warnings: string[] = [];
  if (config.auth.devLogin) {
    const password = config.demoUser.password;
    if (!password || password.length < 12) {
      throw new SeedError("DEMO_USER_PASSWORD (12+ characters) is required when AUTH_DEV_LOGIN=true.");
    }
    return { domain, password, warnings };
  }
  if (config.demoUser.password) warnings.push("DEMO_USER_PASSWORD is ignored because AUTH_DEV_LOGIN is not true.");
  return { domain, password: undefined, warnings };
}

/** Runs the seed on `db` in one transaction and returns the counts. */
export async function runSeed(db: Db, config: AppConfig, options: SeedOptions = {}): Promise<SeedCounts & { warnings: string[] }> {
  const { domain, password, warnings } = seedPreconditions(config);

  const migrated = await db.execute<{ table: string | null }>(sql`SELECT to_regclass('public.templates')::text AS "table"`);
  if (!migrated.rows[0]?.table) throw new SeedError("Run db:migrate first.");

  const uploadedKeys: string[] = [];
  const storage = options.synthetic === false ? undefined : (options.storage ?? getStorage());
  try {
    const counts = await db.transaction(async (tx) => {
      // Concurrent runs wait for each other, so each sees the other's rows.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('db:seed'))`);
      const base = {
        settings: await seedSettings(tx),
        masterData: await seedMasterData(tx),
        templates: await seedTemplates(tx),
        ...(await seedUsers(tx, domain, password)),
      };
      if (!storage) return base;
      const synthetic = await seedSynthetic(tx, { storage, emailHashKey: config.emailHashKey, domain, now: options.now ?? new Date(), uploadedKeys });
      return { ...base, synthetic };
    });
    return { ...counts, warnings };
  } catch (err) {
    // Q3: blobs can't join the transaction; remove what this run uploaded (best effort, keys only in the log).
    for (const key of uploadedKeys) {
      await storage!.delete(key).catch((deleteError: unknown) => logger.warn({ storage_key: key, err: { message: (deleteError as Error).message } }, "seed blob not deleted"));
    }
    throw err;
  }
}

function tally(results: boolean[]) {
  const inserted = results.filter(Boolean).length;
  return { inserted, skipped: results.length - inserted };
}

/** One row per §5.1 key from the same defaults getSetting() uses, `updated_by` NULL (shown as Default). */
async function seedSettings(tx: Tx) {
  const results: boolean[] = [];
  for (const key of SETTING_KEYS) {
    const inserted = await tx
      .insert(settings)
      .values({ key, value: String(SETTING_DEFINITIONS[key].defaultValue), updatedBy: null })
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });
    results.push(inserted.length > 0);
  }
  return tally(results);
}

async function seedMasterData(tx: Tx) {
  const results: boolean[] = [];
  for (const record of SEED_MASTER_DATA) {
    const inserted = await tx
      .insert(masterData)
      .values({ type: record.type, picklistKey: record.picklistKey ?? null, code: record.code, label: record.label })
      .onConflictDoNothing()
      .returning({ id: masterData.id });
    results.push(inserted.length > 0);
  }
  return tally(results);
}

async function seedTemplates(tx: Tx) {
  const results: boolean[] = [];
  for (const template of SEED_TEMPLATES) {
    // A stage email is skipped when any EMAIL template (active or not) already
    // has its trigger: the Admin replaced or retired it on purpose.
    if (template.type === "EMAIL" && template.triggerStatus) {
      const [taken] = await tx
        .select({ id: templates.id })
        .from(templates)
        .where(and(eq(templates.type, "EMAIL"), eq(templates.triggerStatus, template.triggerStatus)))
        .limit(1);
      if (taken) {
        results.push(false);
        continue;
      }
    }
    const inserted = await tx
      .insert(templates)
      .values({
        type: template.type,
        name: template.name,
        subject: template.type === "EMAIL" ? template.subject : null,
        body: template.type === "REQUISITION" ? null : template.body,
        triggerStatus: template.type === "EMAIL" ? template.triggerStatus : null,
        schemaJson: template.type === "REQUISITION" ? template.schemaJson : null,
      })
      .onConflictDoNothing({ target: [templates.type, templates.name] })
      .returning({ id: templates.id });
    results.push(inserted.length > 0);
  }
  return tally(results);
}

/**
 * Inserts missing demo users (never changing an existing user's role, name or
 * active flag) with a USER_CREATED audit row, then sets the dev password of
 * all four when one is given.
 */
async function seedUsers(tx: Tx, domain: string, password: string | undefined) {
  const results: boolean[] = [];
  let passwordsSet = 0;
  for (const demo of SEED_DEMO_USERS) {
    const email = `${demo.localPart}@${domain}`;
    const [inserted] = await tx
      .insert(users)
      .values({ email, name: demo.name, role: demo.role, isActive: true, emailVerified: true, image: null })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (inserted) {
      await tx.insert(auditLog).values({
        actorUserId: null,
        action: "USER_CREATED",
        subjectType: "USER",
        subjectId: inserted.id,
        detailsJson: { role: demo.role },
      });
    }
    results.push(inserted !== undefined);
    if (password) {
      const userId = inserted?.id ?? (await tx.select({ id: users.id }).from(users).where(eq(users.email, email)))[0].id;
      await setDevPassword(tx, userId, password);
      passwordsSet += 1;
    }
  }
  return { users: tally(results), passwordsSet };
}

/** The counts as printed lines, e.g. `settings: 8 inserted, 0 skipped`. */
export function formatCounts(counts: SeedCounts): string[] {
  const line = (label: string, { inserted, skipped }: { inserted: number; skipped: number }) =>
    `${label}: ${inserted} inserted, ${skipped} skipped`;
  return [
    line("settings", counts.settings),
    line("master data", counts.masterData),
    line("templates", counts.templates),
    line("users", counts.users),
    `dev passwords: ${counts.passwordsSet} set`,
    ...(counts.synthetic === undefined
      ? []
      : [
          counts.synthetic.skipped
            ? "synthetic: skipped (requisitions exist)"
            : `synthetic: ${counts.synthetic.requisitions} requisitions, ${counts.synthetic.applications} applications, ${counts.synthetic.files} files`,
        ]),
  ];
}

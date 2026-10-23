// Settings (ats-project-scope.md §5.1). Every setting is read through
// getSetting(), which returns the §5.1 default when no row exists. Values are
// stored as text and parsed per key with Zod. There is no in-process cache,
// so an Admin's change applies on the next read. Admins change them through
// updateSettings(), which validates, saves and audits in one transaction.
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { auditLog, settings } from "../db/schema";
import { logger } from "../logger";

export const DEFAULT_PRIVACY_STATEMENT_TEXT = [
  "Privacy statement (demo)",
  "",
  "This is a demonstration recruiting system. Do not submit real personal data.",
  "We use the details you provide only to process your application for the position you applied for.",
  "Your application is deleted or anonymized after the retention period configured by the administrator.",
].join("\n");

type Definition =
  | { kind: "integer"; min: number; max: number; defaultValue: number }
  | { kind: "email"; defaultValue: string }
  | { kind: "text" | "multiline"; max: number; defaultValue: string };

/** Every §5.1 setting, in table order: its kind, allowed values and default. */
export const SETTING_DEFINITIONS = {
  RETENTION_DAYS: { kind: "integer", min: 1, max: 3650, defaultValue: 180 },
  REJECTION_EMAIL_DELAY_HOURS: { kind: "integer", min: 0, max: 168, defaultValue: 24 },
  APPROVAL_REMINDER_DAYS: { kind: "integer", min: 1, max: 30, defaultValue: 3 },
  MAX_UPLOAD_MB: { kind: "integer", min: 1, max: 10, defaultValue: 5 },
  SENDER_EMAIL: { kind: "email", defaultValue: "careers@ats-demo.local" },
  FALLBACK_REPLY_TO_EMAIL: { kind: "email", defaultValue: "recruiting@ats-demo.local" },
  PRIVACY_STATEMENT_VERSION: { kind: "text", max: 20, defaultValue: "1.0" },
  PRIVACY_STATEMENT_TEXT: { kind: "multiline", max: 20_000, defaultValue: DEFAULT_PRIVACY_STATEMENT_TEXT },
} as const satisfies Record<string, Definition>;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFINITIONS)[K]["defaultValue"] extends number
  ? number
  : string;

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

// What an Admin may submit (§5.1 "Allowed values"). Numbers may arrive as
// JSON numbers or as digit strings from a form field. Stored values are
// parsed with the same schema, so a hand-edited row out of range is ignored.
function inputSchema(definition: Definition): z.ZodType<string | number> {
  switch (definition.kind) {
    case "integer":
      return z
        .union([z.number(), z.string().trim().regex(/^\d+$/).transform(Number)])
        .pipe(z.number().int().min(definition.min).max(definition.max));
    case "email":
      return z.string().trim().toLowerCase().pipe(z.email());
    case "text":
      return z.string().trim().min(1).max(definition.max);
    case "multiline":
      return z.string().min(1).max(definition.max);
  }
}

/** The one schema for Admin input; the form mirrors it. Unknown keys are refused. */
export const settingsInputSchema = z
  .object(Object.fromEntries(SETTING_KEYS.map((key) => [key, inputSchema(SETTING_DEFINITIONS[key])])) as Record<SettingKey, z.ZodType<string | number>>)
  .partial()
  .strict();

/** Parses a stored text value; undefined when it isn't valid for the key. */
export function parseSetting<K extends SettingKey>(key: K, raw: string): SettingValue<K> | undefined {
  const result = inputSchema(SETTING_DEFINITIONS[key]).safeParse(raw);
  return result.success ? (result.data as SettingValue<K>) : undefined;
}

/**
 * The current value of `key`: the stored row parsed for its type, or the
 * §5.1 default when there is no row. A stored value that doesn't parse also
 * gives the default, with a warning that names the key only (M2).
 */
export async function getSetting<K extends SettingKey>(key: K, db: Db | Tx = getDb()): Promise<SettingValue<K>> {
  const defaultValue = SETTING_DEFINITIONS[key].defaultValue as SettingValue<K>;
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  if (!row) return defaultValue;
  const value = parseSetting(key, row.value);
  if (value === undefined) {
    logger.warn({ key }, "invalid stored setting, using the default");
    return defaultValue;
  }
  return value;
}

/** RETENTION_DAYS, read only here (tradeoffs.md upgrade foundations; RT2 uses it). */
export function getRetentionDays(db: Db | Tx = getDb()): Promise<number> {
  return getSetting("RETENTION_DAYS", db);
}

export type EffectiveSetting = {
  key: SettingKey;
  value: string | number;
  isDefault: boolean;
  /** For the form's mirror of the input schema. */
  input: Definition;
};

/**
 * Every setting with its effective value. `isDefault` when no row is stored
 * or the row was seeded (`updated_by IS NULL`), as §5.1 shows them.
 */
export async function listSettings(db: Db | Tx = getDb()): Promise<EffectiveSetting[]> {
  const rows = await db.select().from(settings);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return SETTING_KEYS.map((key) => {
    const row = byKey.get(key);
    const parsed = row ? parseSetting(key, row.value) : undefined;
    return {
      key,
      value: parsed ?? SETTING_DEFINITIONS[key].defaultValue,
      isDefault: !row || row.updatedBy === null || parsed === undefined,
      input: SETTING_DEFINITIONS[key],
    };
  });
}

export type SettingsInput = z.infer<typeof settingsInputSchema>;

/** Field errors as message keys: a setting key's own error, `privacyVersion`, or `unknownKey`. */
export type SettingsErrors = Partial<Record<string, "invalid" | "privacyVersion" | "unknownKey">>;

export type UpdateSettingsResult = { ok: true; changed: SettingKey[] } | { ok: false; errors: SettingsErrors };

/**
 * Validates `input` and saves the keys whose value differs from the current
 * one, all or nothing: each changed key is upserted with `updated_by` and
 * writes one SETTING_CHANGED audit row with `{ key }` only (M2). A changed
 * privacy statement text needs a different version, so `consent_version`
 * always identifies the text a candidate saw.
 */
export async function updateSettings(tx: Tx, actorUserId: string, input: unknown): Promise<UpdateSettingsResult> {
  const parsed = settingsInputSchema.safeParse(input);
  if (!parsed.success) {
    const errors: SettingsErrors = {};
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") for (const key of issue.keys) errors[key] = "unknownKey";
      else if (typeof issue.path[0] === "string") errors[issue.path[0]] = "invalid";
      else errors._ = "invalid";
    }
    return { ok: false, errors };
  }

  // Serialised against other Admins' saves, so the comparison below holds.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('settings'))`);
  const current = new Map((await listSettings(tx)).map((setting) => [setting.key, setting.value]));
  const changed = (Object.entries(parsed.data) as [SettingKey, string | number][]).filter(
    ([key, value]) => current.get(key) !== value,
  );

  const changedKeys = new Set(changed.map(([key]) => key));
  if (changedKeys.has("PRIVACY_STATEMENT_TEXT") && !changedKeys.has("PRIVACY_STATEMENT_VERSION")) {
    return { ok: false, errors: { PRIVACY_STATEMENT_VERSION: "privacyVersion" } };
  }

  for (const [key, value] of changed) {
    const now = new Date();
    await tx
      .insert(settings)
      .values({ key, value: String(value), updatedBy: actorUserId })
      .onConflictDoUpdate({ target: settings.key, set: { value: String(value), updatedBy: actorUserId, updatedAt: now } });
    await tx.insert(auditLog).values({
      actorUserId,
      action: "SETTING_CHANGED",
      subjectType: "SETTING",
      subjectId: null,
      detailsJson: { key },
    });
  }
  logger.info({ user_id: actorUserId, keys: [...changedKeys] }, "settings changed");
  return { ok: true, changed: [...changedKeys] };
}

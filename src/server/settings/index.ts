// The typed settings reader (ats-project-scope.md §5.1). Every setting is
// read through getSetting(), which returns the §5.1 default when no row
// exists. Values are stored as text and parsed per key with Zod. There is no
// in-process cache, so an Admin's change applies on the next read.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { settings } from "../db/schema";
import { logger } from "../logger";

const integer = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

export const DEFAULT_PRIVACY_STATEMENT_TEXT = [
  "Privacy statement (demo)",
  "",
  "This is a demonstration recruiting system. Do not submit real personal data.",
  "We use the details you provide only to process your application for the position you applied for.",
  "Your application is deleted or anonymized after the retention period configured by the administrator.",
].join("\n");

/** Key, parser and default of every §5.1 setting, in table order. */
export const SETTING_DEFINITIONS = {
  RETENTION_DAYS: { schema: integer(1, 3650), defaultValue: 180 },
  REJECTION_EMAIL_DELAY_HOURS: { schema: integer(0, 168), defaultValue: 24 },
  APPROVAL_REMINDER_DAYS: { schema: integer(1, 30), defaultValue: 3 },
  MAX_UPLOAD_MB: { schema: integer(1, 10), defaultValue: 5 },
  SENDER_EMAIL: { schema: z.email(), defaultValue: "careers@ats-demo.local" },
  FALLBACK_REPLY_TO_EMAIL: { schema: z.email(), defaultValue: "recruiting@ats-demo.local" },
  PRIVACY_STATEMENT_VERSION: { schema: z.string().min(1).max(20), defaultValue: "1.0" },
  PRIVACY_STATEMENT_TEXT: { schema: z.string().min(1).max(20_000), defaultValue: DEFAULT_PRIVACY_STATEMENT_TEXT },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFINITIONS)[K]["defaultValue"] extends number
  ? number
  : string;

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

/** Parses a stored text value; undefined when it isn't valid for the key. */
export function parseSetting<K extends SettingKey>(key: K, raw: string): SettingValue<K> | undefined {
  const result = SETTING_DEFINITIONS[key].schema.safeParse(raw);
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

// The one logger (tech-stack.md §13 M1): pino JSON lines on stdout, no
// transports or worker threads. It reads only LOG_LEVEL and never getConfig()
// (§3 rule 5 exception), so a configuration error can itself be logged.
import pino, { type DestinationStream, type Logger } from "pino";

// M2: logs carry identifiers only. These paths are the safety net for
// personal fields and request secrets that slip into a log call anyway.
const REDACTED_KEYS = [
  "email",
  "recipient",
  "cc",
  "replyTo",
  "reply_to",
  "name",
  "firstName",
  "first_name",
  "lastName",
  "last_name",
  "phone",
  "salary",
  "comment",
  "comments",
  "body",
  "bodyRendered",
  "body_rendered",
  "icsContent",
  "ics_content",
  "authorization",
  "cookie",
  "set-cookie",
  "x-tick-secret",
];

export const REDACT_PATHS = REDACTED_KEYS.flatMap((key) => {
  const property = /^\w+$/.test(key) ? key : `["${key}"]`;
  return [property, property.startsWith("[") ? `*${property}` : `*.${property}`];
});

function logLevel(): string {
  const level = process.env.LOG_LEVEL;
  // An invalid level is reported by getConfig(); the logger must still work.
  return level && (level === "silent" || level in pino.levels.values) ? level : "info";
}

/** Creates a logger with the shared settings; tests pass their own destination. */
export function createLogger(destination?: DestinationStream): Logger {
  return pino({ level: logLevel(), redact: { paths: REDACT_PATHS, censor: "[Redacted]" } }, destination);
}

export const logger = createLogger();

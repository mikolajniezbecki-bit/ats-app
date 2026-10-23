// The anti-spam checks in front of submitApplication (ats-project-scope.md
// F6; tech-stack.md §3 rule 9), in this order: rate limit (every attempt
// counts, before anything else), honeypot, Turnstile. They don't change
// submitApplication. Logs name the check that refused and the requisition,
// never the IP, the key, the token or form content (M2).
import { getCaptcha } from "../adapters/captcha";
import { getConfig } from "../config";
import { getClientIp, rateLimitKeyForIp } from "../http/client-ip";
import { logger } from "../logger";
import { countAttempt, shouldEnforceRateLimit } from "../ratelimit";

export type GuardRefusal = { reason: "rateLimited"; httpStatus: 429 } | { reason: "honeypot" | "captcha"; httpStatus: 400 };

type HeaderReader = { get(name: string): string | null };

export async function checkApplyAttempt(input: {
  headers: HeaderReader;
  honeypot: string;
  captchaToken: string | null;
  /** For the log only: resolved when a check refuses. */
  requisitionId: () => Promise<string | undefined>;
}): Promise<GuardRefusal | null> {
  const { ip, source } = getClientIp(input.headers);
  const refused = async (check: string, extra: Record<string, unknown> = {}) =>
    logger.info({ requisition_id: await input.requisitionId(), ip_source: source, check, ...extra }, "application refused");
  if (shouldEnforceRateLimit({ authDevLogin: getConfig().auth.devLogin, headerValue: input.headers.get("x-enforce-rate-limit") })) {
    const { allowed } = await countAttempt(rateLimitKeyForIp(ip));
    if (!allowed) {
      await refused("rateLimit");
      return { reason: "rateLimited", httpStatus: 429 };
    }
  }
  if (input.honeypot !== "") {
    await refused("honeypot");
    return { reason: "honeypot", httpStatus: 400 };
  }
  const captcha = await getCaptcha().verify(input.captchaToken, ip);
  if (!captcha.ok) {
    await refused("captcha", { captcha_reason: captcha.reason });
    return { reason: "captcha", httpStatus: 400 };
  }
  return null;
}

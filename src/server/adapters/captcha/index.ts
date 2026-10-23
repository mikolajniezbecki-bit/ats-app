// CaptchaService (tech-stack.md §3 rule 4; ats-project-scope.md F6): the only
// code that calls Cloudflare Turnstile. It fails closed: a missing token, a
// rejection, a non-200 response, a timeout or a network error is `ok: false`.
// `reason` carries Cloudflare's error codes for the log, never the token.
import { getConfig } from "../../config";

export type CaptchaResult = { ok: boolean; reason?: string };

export interface CaptchaService {
  verify(token: string | null | undefined, remoteIp: string): Promise<CaptchaResult>;
}

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5_000;

export function createTurnstileService(options: { secretKey: string; fetch?: typeof fetch; timeoutMs?: number }): CaptchaService {
  const doFetch = options.fetch ?? fetch;
  return {
    async verify(token, remoteIp) {
      if (!token) return { ok: false, reason: "missing-input-response" };
      try {
        const response = await doFetch(SITEVERIFY_URL, {
          method: "POST",
          body: new URLSearchParams({ secret: options.secretKey, response: token, remoteip: remoteIp }),
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        if (!response.ok) return { ok: false, reason: `http-${response.status}` };
        const body = (await response.json()) as { success?: boolean; "error-codes"?: string[] };
        if (body.success === true) return { ok: true };
        return { ok: false, reason: (body["error-codes"] ?? []).join(",") || "rejected" };
      } catch (err) {
        return { ok: false, reason: (err as Error).name === "TimeoutError" ? "timeout" : "network-error" };
      }
    },
  };
}

let instance: CaptchaService | undefined;

/** The process's CAPTCHA service, created on first use (never at import time, W1). */
export function getCaptcha(): CaptchaService {
  instance ??= createTurnstileService({ secretKey: getConfig().turnstile.secretKey });
  return instance;
}

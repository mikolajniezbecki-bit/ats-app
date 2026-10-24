"use client";

// Cloudflare Turnstile widget (ats-project-scope.md F6). The script is added
// with the request's CSP nonce; the widget puts its single-use token into a
// hidden `cf-turnstile-response` field of the surrounding form. `resetKey`
// changes after every refused submission, which resets the widget so the
// next try uses a new token.
import { useEffect, useRef } from "react";

type Turnstile = {
  render(container: HTMLElement, options: { sitekey: string }): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadScript(nonce: string | undefined): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      if (nonce) script.nonce = nonce;
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile script failed to load")), { once: true });
  });
}

export function TurnstileWidget({ siteKey, nonce, resetKey, label }: { siteKey: string; nonce?: string; resetKey: number; label: string }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadScript(nonce).then(() => {
      if (cancelled || !container.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(container.current, { sitekey: siteKey });
    });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, nonce]);

  useEffect(() => {
    if (resetKey > 0 && widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, [resetKey]);

  return <div ref={container} role="group" aria-label={label} data-testid="turnstile" className="min-h-16" />;
}

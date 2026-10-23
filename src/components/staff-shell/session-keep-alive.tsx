"use client";

import { useEffect } from "react";

/**
 * AU6 sliding expiry for the cookie: server components can extend the session
 * row but can't set cookies, so staff pages call get-session once on load. A
 * route handler can, and Better Auth re-sends the cookie with a fresh 8 h
 * lifetime when it refreshes the session (at most once per hour).
 */
export function SessionKeepAlive() {
  useEffect(() => {
    void fetch("/api/auth/get-session", { cache: "no-store" }).catch(() => undefined);
  }, []);
  return null;
}

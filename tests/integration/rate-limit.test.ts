// The apply rate limit against the database (ats-project-scope.md F6;
// tech-stack.md §3 rule 9): one-minute buckets summed over a sliding hour,
// counted under an advisory lock, and the guard's order of checks. The
// guard tests stop before Turnstile, so they need no network.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { checkApplyAttempt } from "@/server/apply/guard";
import { getDb } from "@/server/db";
import { rateLimits } from "@/server/db/schema";
import { rateLimitKeyForIp } from "@/server/http/client-ip";
import { countAttempt } from "@/server/ratelimit";

const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const key = () => `apply:test-${randomUUID()}`;

describe("countAttempt", () => {
  it("F6: five attempts within an hour are allowed, the sixth is refused, and it still counts", async () => {
    const k = key();
    const now = new Date("2030-05-05T10:00:30Z");
    for (let i = 1; i <= 5; i++) expect(await countAttempt(k, new Date(now.getTime() + i * 1_000))).toEqual({ allowed: true, count: i });
    expect(await countAttempt(k, new Date(now.getTime() + 10 * 60_000))).toEqual({ allowed: false, count: 6 });
    const rows = await getDb().select().from(rateLimits).where(eq(rateLimits.key, k));
    expect(rows.map((row) => [row.windowStart.toISOString(), row.count])).toEqual(
      expect.arrayContaining([
        ["2030-05-05T10:00:00.000Z", 5],
        ["2030-05-05T10:10:00.000Z", 1],
      ]),
    );
  });

  it("F6: the window slides: after five in the first minute, an attempt 61 minutes later is allowed", async () => {
    const k = key();
    const start = new Date("2030-05-05T10:59:10Z");
    for (let i = 0; i < 5; i++) await countAttempt(k, start);
    expect((await countAttempt(k, new Date(start.getTime() + 30 * 60_000))).allowed).toBe(false);
    expect(await countAttempt(k, new Date(start.getTime() + 61 * 60_000))).toEqual({ allowed: true, count: 2 });
  });

  it("F6: concurrent attempts can't all slip through", async () => {
    const k = key();
    const now = new Date("2030-05-05T12:00:00Z");
    const results = await Promise.all(Array.from({ length: 8 }, () => countAttempt(k, now)));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.map((result) => result.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("checkApplyAttempt", () => {
  it("F6: after five attempts from one IP the sixth is refused with 429 before the other checks; another IP isn't", async () => {
    const ip = randomIp();
    for (let i = 0; i < 5; i++) await countAttempt(rateLimitKeyForIp(ip));
    const headers = new Headers({ "x-forwarded-for": `6.6.6.6, ${ip}` });
    expect(await checkApplyAttempt({ headers, honeypot: "", captchaToken: null })).toEqual({ reason: "rateLimited", httpStatus: 429 });
    // A different address gets past the limit and is stopped by the honeypot instead.
    expect(await checkApplyAttempt({ headers: new Headers({ "x-forwarded-for": randomIp() }), honeypot: "filled", captchaToken: null })).toEqual({
      reason: "honeypot",
      httpStatus: 400,
    });
  });

  it("F6: the client-set first x-forwarded-for entry doesn't bypass the limit", async () => {
    const ip = randomIp();
    for (let i = 0; i < 5; i++) await countAttempt(rateLimitKeyForIp(ip));
    expect(await checkApplyAttempt({ headers: new Headers({ "x-forwarded-for": `${randomIp()}, ${ip}` }), honeypot: "", captchaToken: null })).toMatchObject({
      reason: "rateLimited",
    });
  });
});

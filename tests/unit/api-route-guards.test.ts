// V9: every API route either sits on proxy.ts's public list or checks the
// session and permission itself, so an unguarded route can't be merged
// unnoticed.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/proxy";

const APP_DIR = "src/app";
const GUARDS = /\b(withPermission|requireUser|requirePermission|requireApiUser)\(/;

/** Every route.ts under src/app/api. */
function routeFiles(dir = path.join(APP_DIR, "api")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return /^route\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** The URL path a route file serves: route groups dropped, dynamic segments as a sample value. */
function urlPathOf(file: string): string {
  const segments = path
    .relative(APP_DIR, path.dirname(file))
    .split(path.sep)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.*\]$/.test(segment) ? "sample" : segment));
  return `/${segments.join("/")}`;
}

describe("API route guards", () => {
  it("maps route files to URL paths", () => {
    expect(urlPathOf("src/app/api/auth/[...all]/route.ts")).toBe("/api/auth/sample");
    expect(urlPathOf("src/app/(staff)/api/x/[id]/route.ts")).toBe("/api/x/sample");
  });

  it("finds the existing routes", () => {
    expect(routeFiles().map((file) => urlPathOf(file))).toEqual(expect.arrayContaining(["/api/internal/tick", "/api/auth/sample"]));
  });

  it.each(routeFiles())("%s is public or guarded", (file) => {
    const guarded = GUARDS.test(readFileSync(file, "utf8"));
    expect(isPublicPath(urlPathOf(file)) || guarded, `${file} is neither public in proxy.ts nor uses withPermission`).toBe(true);
  });
});

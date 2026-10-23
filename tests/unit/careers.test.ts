// Job board query parsing (ats-project-scope.md §5.3) and the private
// posting headers set by proxy.ts (§5.2 Postings).
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { likePattern, normalizeBoardQuery } from "@/server/careers";

describe("normalizeBoardQuery", () => {
  it("trims the keywords and cuts them at 100 characters; empty filters count as none", () => {
    expect(normalizeBoardQuery({ q: "  engineer  ", location: "", department: "ENGINEERING" })).toEqual({
      q: "engineer",
      location: undefined,
      department: "ENGINEERING",
      page: 1,
    });
    expect(normalizeBoardQuery({ q: "x".repeat(150) }).q).toHaveLength(100);
    expect(normalizeBoardQuery({ page: "abc" }).page).toBe(1);
    expect(normalizeBoardQuery({ page: "3" }).page).toBe(3);
  });

  it("escapes %, _ and \\ for ILIKE", () => {
    expect(likePattern("50%")).toBe("%50\\%%");
    expect(likePattern("a_b\\c")).toBe("%a\\_b\\\\c%");
  });
});

describe("private posting headers", () => {
  it("/jobs/p/… gets X-Robots-Tag noindex and Referrer-Policy no-referrer; /jobs/… doesn't", () => {
    const privatePage = proxy(new NextRequest("http://localhost:3000/jobs/p/0123456789abcdef0123456789abcdef"));
    expect(privatePage.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(privatePage.headers.get("referrer-policy")).toBe("no-referrer");
    const board = proxy(new NextRequest("http://localhost:3000/jobs"));
    expect(board.headers.get("x-robots-tag")).toBeNull();
    expect(board.headers.get("referrer-policy")).toBeNull();
  });
});

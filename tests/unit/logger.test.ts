import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/server/logger";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      done();
    },
  });
  return { stream, lines, records: () => lines.map((line) => JSON.parse(line)) };
}

describe("logger", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("M1: writes JSON lines with level, time and msg", () => {
    const out = capture();
    createLogger(out.stream).info({ applicationId: "app-1" }, "hello");
    const [record] = out.records();
    expect(record).toMatchObject({ level: 30, msg: "hello", applicationId: "app-1" });
    expect(typeof record.time).toBe("number");
  });

  it("M1: works with an empty environment and defaults to info", () => {
    const saved = process.env;
    process.env = {} as NodeJS.ProcessEnv;
    try {
      const out = capture();
      const log = createLogger(out.stream);
      log.debug("hidden");
      log.info("shown");
      expect(out.records().map((record) => record.msg)).toEqual(["shown"]);
    } finally {
      process.env = saved;
    }
  });

  it("M1: reads LOG_LEVEL and falls back to info for an invalid level", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    expect(createLogger(capture().stream).level).toBe("debug");
    vi.stubEnv("LOG_LEVEL", "verbose");
    expect(createLogger(capture().stream).level).toBe("info");
  });

  it("M2: redacts personal fields at the top level and one level deep", () => {
    const out = capture();
    createLogger(out.stream).info({
      applicationId: "app-1",
      email: "jane.doe@example.com",
      name: "Jane Doe",
      phone: "+48 600 700 800",
      candidate: { email: "jane.doe@example.com", first_name: "Jane" },
    });
    const line = out.lines.join("\n");
    expect(line).toContain("app-1");
    for (const value of ["jane.doe@example.com", "Jane", "+48 600 700 800"]) expect(line).not.toContain(value);
    expect(out.records()[0]).toMatchObject({
      email: "[Redacted]",
      candidate: { email: "[Redacted]", first_name: "[Redacted]" },
    });
  });

  it("M2: redacts every configured key, including request secrets", () => {
    const keys = [
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
    const secret = (key: string) => `secret-${key}`;
    const payload = Object.fromEntries(keys.map((key) => [key, secret(key)]));
    const out = capture();
    createLogger(out.stream).info({ ...payload, headers: payload });
    const line = out.lines.join("\n");
    for (const key of keys) expect(line).not.toContain(secret(key));
  });
});

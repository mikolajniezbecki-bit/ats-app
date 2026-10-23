// The typed settings reader against PostgreSQL (ats-project-scope.md §5.1).
import { describe, expect, it } from "vitest";
import { settings } from "@/server/db/schema";
import { getSetting } from "@/server/settings";
import { rolledBack } from "./helpers";

describe("getSetting", () => {
  it("returns the §5.1 default when no row exists", async () => {
    await rolledBack(async (tx) => {
      await tx.delete(settings);
      expect(await getSetting("MAX_UPLOAD_MB", tx)).toBe(5);
      expect(await getSetting("SENDER_EMAIL", tx)).toBe("careers@ats-demo.local");
    });
  });

  it("returns a stored override, parsed for its type", async () => {
    await rolledBack(async (tx) => {
      await tx.insert(settings).values({ key: "RETENTION_DAYS", value: "30" }).onConflictDoUpdate({ target: settings.key, set: { value: "30" } });
      expect(await getSetting("RETENTION_DAYS", tx)).toBe(30);
    });
  });

  it("falls back to the default for a stored value that doesn't parse", async () => {
    await rolledBack(async (tx) => {
      await tx.insert(settings).values({ key: "MAX_UPLOAD_MB", value: "lots" }).onConflictDoUpdate({ target: settings.key, set: { value: "lots" } });
      expect(await getSetting("MAX_UPLOAD_MB", tx)).toBe(5);
    });
  });
});

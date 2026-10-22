import { inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, withTransaction } from "@/server/db";
import { masterData } from "@/server/db/schema";
import { unique } from "./helpers";

function department(code: string) {
  return { type: "DEPARTMENT" as const, code, label: "Test department" };
}

async function existingCodes(codes: string[]): Promise<string[]> {
  const rows = await getDb().select({ code: masterData.code }).from(masterData).where(inArray(masterData.code, codes));
  return rows.map((row) => row.code).sort();
}

describe("withTransaction", () => {
  it("D3: commits both inserts when fn resolves", async () => {
    const codes = [unique("tx-a"), unique("tx-b")].sort();

    const result = await withTransaction(async (tx) => {
      await tx.insert(masterData).values(department(codes[0]));
      await tx.insert(masterData).values(department(codes[1]));
      return "done";
    });

    expect(result).toBe("done");
    expect(await existingCodes(codes)).toEqual(codes);
  });

  it("D3: rolls back every insert and re-throws the original error when fn rejects", async () => {
    const code = unique("tx-rollback");
    const failure = new Error("domain rule failed");

    const outcome = withTransaction(async (tx) => {
      await tx.insert(masterData).values(department(code));
      throw failure;
    });

    await expect(outcome).rejects.toBe(failure);
    expect(await existingCodes([code])).toEqual([]);
  });
});

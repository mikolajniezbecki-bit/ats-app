// tech-stack.md §3 rule 4: external SDKs are imported only in
// src/server/adapters. Lints sample code with the project's ESLint config.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function restrictedImportErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("adapter-only SDK imports", () => {
  it.each([
    ['import { BlobServiceClient } from "@azure/storage-blob";', "@azure/storage-blob"],
    ['import { DefaultAzureCredential } from "@azure/identity";', "@azure/identity"],
    ['import { PgBoss } from "pg-boss";', "pg-boss"],
  ])("rejects %s outside the adapters", async (code, sdk) => {
    const errors = await restrictedImportErrors(`${code}\nexport const x = 1;\n`, "src/server/domain/sample.ts");
    expect(errors.length, sdk).toBe(1);
  });

  it("allows the Azure SDK inside src/server/adapters", async () => {
    const code = 'import { BlobServiceClient } from "@azure/storage-blob";\nexport const x = BlobServiceClient;\n';
    expect(await restrictedImportErrors(code, "src/server/adapters/storage/sample.ts")).toEqual([]);
  });
});

// Files for specs (F5): stored the way the app stores them, in the Compose
// database and Azurite, from the host.
import { spawnSync } from "node:child_process";
import { hostAppEnvironment } from "./env";

/** Stores `path` (default: the valid PDF fixture) through storePdf() and returns the file ID. */
export function storeTestPdf(path = "tests/fixtures/pdf/valid.pdf"): string {
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "tests/e2e/support/store-pdf.ts"],
    { input: JSON.stringify({ path }), env: { ...process.env, ...hostAppEnvironment() }, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`storePdf failed: ${result.stderr}`);
  return result.stdout.trim();
}

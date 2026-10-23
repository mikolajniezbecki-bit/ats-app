// Emails for Outbox specs, created from the host against the Compose stack.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query } from "./db";
import { hostAppEnvironment } from "./env";

/** A CAPTURED email with an .ics and a PDF attachment (tests/e2e/support/captured-email.ts). */
export function createCapturedEmail(to = `e2e-${randomUUID()}@example.com`): { emailLogId: string; fileId: string; to: string } {
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "tests/e2e/support/captured-email.ts"],
    { input: JSON.stringify({ to }), env: { ...process.env, ...hostAppEnvironment() }, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`createCapturedEmail failed: ${result.stderr}`);
  return { ...(JSON.parse(result.stdout) as { emailLogId: string; fileId: string }), to };
}

/** A logged email with a body the test writes itself (no job). */
export async function insertLoggedEmail(body: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO email_log (audience, recipient, subject, body_rendered, status, sent_at)
     VALUES ('STAFF', $1, 'Hostile body', $2, 'CAPTURED', now()) RETURNING id`,
    [`e2e-${randomUUID()}@example.com`, body],
  );
  return row.id;
}

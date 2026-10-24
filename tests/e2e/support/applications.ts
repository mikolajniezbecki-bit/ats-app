// Applications for specs, inserted straight into the Compose database (no
// Quick Apply, so the apply rate limit never applies), with a stored CV and
// the creation history row apply writes.
import { randomUUID } from "node:crypto";
import { query } from "./db";
import { storeTestPdf } from "./files";

export type SpecApplication = { id: string; email: string; firstName: string; lastName: string };

export async function insertApplication(
  requisitionId: string,
  options: { email?: string; emailHash?: string; status?: string; withCv?: boolean } = {},
): Promise<SpecApplication> {
  const email = options.email ?? `e2e-${randomUUID()}@example.com`;
  const firstName = "Łucja";
  const lastName = `Workbench ${randomUUID().slice(0, 6)}`;
  const status = options.status ?? "APPLIED";
  const [row] = await query<{ id: string }>(
    `INSERT INTO applications (requisition_id, first_name, last_name, email, email_hash, phone, status, source, consent_accepted_at, consent_version)
     VALUES ($1, $2, $3, $4, $5, '+00 600 100 200', $6, 'CAREER_SITE', now(), '1.0') RETURNING id`,
    [requisitionId, firstName, lastName, email, options.emailHash ?? randomUUID(), status],
  );
  await query("INSERT INTO application_history (application_id, from_status, to_status) VALUES ($1, NULL, $2)", [row.id, status]);
  if (options.withCv ?? true) {
    const fileId = storeTestPdf();
    await query("UPDATE files SET owner_id = $1 WHERE id = $2", [row.id, fileId]);
  }
  return { id: row.id, email, firstName, lastName };
}

// Requisitions for specs, inserted straight into the shared Compose database
// with the seeded master data and the shared e2e users (T2: each spec creates
// its own rows).
import { randomUUID } from "node:crypto";
import { query } from "./db";
import { ROLES } from "./users";

type Overrides = {
  title?: string;
  state?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "ON_HOLD" | "CLOSED";
  postingType?: "EXTERNAL" | "PRIVATE";
  isPublished?: boolean;
  approved?: boolean;
  descriptionHtml?: string;
  departmentCode?: string;
  locationCode?: string;
  privateSlug?: string | null;
};

export type SpecRequisition = { id: string; reqNumber: string; title: string; privateSlug: string | null };

async function masterDataId(type: string, code: string): Promise<string> {
  const [row] = await query<{ id: string }>("SELECT id FROM master_data WHERE type = $1 AND code = $2", [type, code]);
  if (!row) throw new Error(`Seeded ${type} ${code} is missing; run the seed`);
  return row.id;
}

async function userId(email: string): Promise<string> {
  const [row] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  return row.id;
}

export async function insertRequisition(overrides: Overrides = {}): Promise<SpecRequisition> {
  const title = overrides.title ?? `E2E Job ${randomUUID().slice(0, 8)}`;
  const recruiter = await userId(ROLES.recruiter.email);
  const hm = await userId(ROLES["hiring-manager"].email);
  const postingType = overrides.postingType ?? "EXTERNAL";
  const slug = overrides.privateSlug !== undefined ? overrides.privateSlug : postingType === "PRIVATE" ? randomUUID().replaceAll("-", "") : null;
  const [row] = await query<{ id: string; req_number: string; private_slug: string | null }>(
    `INSERT INTO requisitions (title, department_id, location_id, legal_entity_id, hiring_manager_id, recruiter_id, created_by_user_id,
       openings_count, description_html, posting_type, private_slug, state, is_published, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 1, $7, $8, $9, $10, $11, $12)
     RETURNING id, req_number, private_slug`,
    [
      title,
      await masterDataId("DEPARTMENT", overrides.departmentCode ?? "ENGINEERING"),
      await masterDataId("LOCATION", overrides.locationCode ?? "WARSAW"),
      await masterDataId("LEGAL_ENTITY", "DEMO_PL"),
      hm,
      recruiter,
      overrides.descriptionHtml ?? "<p>An E2E job.</p>",
      postingType,
      slug,
      overrides.state ?? "DRAFT",
      overrides.isPublished ?? false,
      overrides.approved ? new Date() : null,
    ],
  );
  return { id: row.id, reqNumber: row.req_number, title, privateSlug: row.private_slug };
}

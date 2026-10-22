// Minimal valid rows for the recruiting tables, so each test spells out only
// the columns it is about. All inserts go through the caller's transaction.
import type { Tx } from "@/server/db";
import {
  applications,
  interviews,
  masterData,
  offers,
  requisitions,
  templates,
  users,
} from "@/server/db/schema";
import { unique } from "./helpers";

type Role = (typeof users.$inferInsert)["role"];

export async function insertUser(tx: Tx, role: Role = "RECRUITER") {
  const [row] = await tx
    .insert(users)
    .values({ email: `${unique("user")}@example.com`, name: "Test User", role })
    .returning();
  return row;
}

async function insertMasterData(tx: Tx, type: "DEPARTMENT" | "LOCATION" | "LEGAL_ENTITY") {
  const [row] = await tx.insert(masterData).values({ type, code: unique(type), label: type }).returning();
  return row;
}

export async function insertRequisition(tx: Tx, overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  const user = await insertUser(tx);
  const [row] = await tx
    .insert(requisitions)
    .values({
      title: "Backend Engineer",
      departmentId: (await insertMasterData(tx, "DEPARTMENT")).id,
      locationId: (await insertMasterData(tx, "LOCATION")).id,
      legalEntityId: (await insertMasterData(tx, "LEGAL_ENTITY")).id,
      hiringManagerId: user.id,
      recruiterId: user.id,
      createdByUserId: user.id,
      openingsCount: 1,
      postingType: "EXTERNAL",
      ...overrides,
    })
    .returning();
  return row;
}

export function applicationValues(requisitionId: string) {
  return {
    requisitionId,
    firstName: "Ada",
    lastName: "Lovelace",
    email: `${unique("ada")}@example.com`,
    emailHash: unique("hash"),
    phone: "+48 123 456 789",
    source: "CAREER_SITE",
    consentAcceptedAt: new Date(),
    consentVersion: "1.0",
  } satisfies typeof applications.$inferInsert;
}

export async function insertApplication(tx: Tx, overrides: Partial<typeof applications.$inferInsert> = {}) {
  const requisitionId = overrides.requisitionId ?? (await insertRequisition(tx)).id;
  const [row] = await tx
    .insert(applications)
    .values({ ...applicationValues(requisitionId), ...overrides })
    .returning();
  return row;
}

export async function insertInterview(tx: Tx) {
  const application = await insertApplication(tx);
  const [row] = await tx
    .insert(interviews)
    .values({
      applicationId: application.id,
      startsAtUtc: new Date(),
      durationMinutes: 60,
      timezone: "Europe/Warsaw",
      locationOrLink: "Room 1",
      icsUid: unique("ics"),
      createdByUserId: (await insertUser(tx)).id,
    })
    .returning();
  return row;
}

export async function offerValues(tx: Tx) {
  const [template] = await tx
    .insert(templates)
    .values({ type: "OFFER", name: unique("offer"), body: "Letter" })
    .returning();
  return {
    applicationId: (await insertApplication(tx)).id,
    templateId: template.id,
    createdByUserId: (await insertUser(tx)).id,
    jobTitle: "Backend Engineer",
    salary: "10000.00",
    currency: "EUR",
    startDate: "2027-01-01",
  } satisfies typeof offers.$inferInsert;
}

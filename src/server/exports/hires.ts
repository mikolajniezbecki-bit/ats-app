// The hire export (ats-project-scope.md §5.6 Hire export, V10; tech-stack.md
// D3, M2): hired, non-anonymized applications with the terms of their
// accepted offer, as CSV. The default export holds only hires not exported
// yet and marks them; `includeExported` adds earlier exports without
// changing their `exported_at`. One transaction: the rows are locked FOR
// UPDATE, so of two concurrent default exports the second waits and then
// skips what the first marked. The CSV is built in memory and never stored
// or logged; the audit row and the log carry counts only.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Db, type Tx, getDb } from "../db";
import { applications, auditLog, masterData, offers, requisitions } from "../db/schema";
import { warsawRunDate } from "../domain/daily-tasks";
import { logger } from "../logger";
import { type CsvColumn, toCsv } from "./csv";

export const HIRE_COLUMNS: CsvColumn[] = [
  { header: "Application ID" },
  { header: "Requisition number" },
  { header: "First name" },
  { header: "Last name" },
  { header: "Email" },
  // §7 limits phone numbers to digits, spaces and `+ - ( )`, so a leading `+` stays.
  { header: "Phone", raw: true },
  { header: "Job title" },
  { header: "Department" },
  { header: "Location" },
  { header: "Legal entity" },
  { header: "Start date" },
  { header: "Salary" },
  { header: "Currency" },
  { header: "Hired date" },
];

const exportable = (includeExported: boolean) =>
  and(eq(applications.status, "HIRED"), isNull(applications.anonymizedAt), includeExported ? undefined : isNull(applications.exportedAt));

/** The page's count: hires a default export would contain now. */
export async function countNewHires(db: Db | Tx = getDb()): Promise<number> {
  const [row] = await db.select({ value: sql<number>`count(*)::int` }).from(applications).where(exportable(false));
  return row.value;
}

export type HireExport = { csv: string; filename: string; rowCount: number; newlyExportedCount: number };

/** Builds the export for `actor`, marks first-time rows and writes EXPORT_HIRES (D3: all in `tx`). */
export async function exportHires(tx: Tx, actor: { id: string }, options: { includeExported: boolean }, now = new Date()): Promise<HireExport> {
  const department = alias(masterData, "department");
  const location = alias(masterData, "location");
  const legalEntity = alias(masterData, "legal_entity");
  // Master data labels are joined whatever is_active is: a deactivated department still names the hire's.
  const rows = await tx
    .select({
      id: applications.id,
      exportedAt: applications.exportedAt,
      reqNumber: requisitions.reqNumber,
      firstName: applications.firstName,
      lastName: applications.lastName,
      email: applications.email,
      phone: applications.phone,
      jobTitle: offers.jobTitle,
      department: department.label,
      location: location.label,
      legalEntity: legalEntity.label,
      startDate: offers.startDate,
      salary: offers.salary,
      currency: offers.currency,
      hiredAt: applications.hiredAt,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(department, eq(department.id, requisitions.departmentId))
    .innerJoin(location, eq(location.id, requisitions.locationId))
    .innerJoin(legalEntity, eq(legalEntity.id, requisitions.legalEntityId))
    // R2: a hire has exactly one accepted offer (no new offer can be created while one is accepted).
    .innerJoin(offers, and(eq(offers.applicationId, applications.id), eq(offers.candidateResponse, "ACCEPTED")))
    .where(exportable(options.includeExported))
    .orderBy(asc(applications.hiredAt), asc(applications.id))
    .for("update", { of: applications });

  const firstTime = rows.filter((row) => row.exportedAt === null).map((row) => row.id);
  if (firstTime.length > 0) {
    // Not a status change: no version bump, no history. Re-exports keep their first value.
    await tx
      .update(applications)
      .set({ exportedAt: now })
      .where(and(inArray(applications.id, firstTime), isNull(applications.exportedAt)));
  }
  const details = { includeExported: options.includeExported, rowCount: rows.length, newlyExportedCount: firstTime.length };
  await tx.insert(auditLog).values({ actorUserId: actor.id, action: "EXPORT_HIRES", subjectType: null, detailsJson: details });
  logger.info({ user_id: actor.id, include_exported: options.includeExported, row_count: rows.length, newly_exported: firstTime.length }, "hires exported");

  const csv = toCsv(
    HIRE_COLUMNS,
    rows.map((row) => [
      row.id,
      row.reqNumber,
      row.firstName,
      row.lastName,
      row.email,
      row.phone,
      row.jobTitle,
      row.department,
      row.location,
      row.legalEntity,
      row.startDate,
      Number(row.salary).toFixed(2),
      row.currency,
      row.hiredAt ? warsawRunDate(row.hiredAt) : null,
    ]),
  );
  return { csv, filename: `hires-${warsawRunDate(now)}.csv`, ...details };
}

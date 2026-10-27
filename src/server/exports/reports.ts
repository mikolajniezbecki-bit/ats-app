// The requisition and pipeline CSV exports (ats-project-scope.md §5.9,
// V10; task 41 Q3, Q4). They change nothing, write no audit row and carry
// no candidate contact data: the hire export is the only hand-off of
// personal data. The row mappers are pure and unit-tested; the CSV writer
// is #45's (BOM, quoting, formula prefix).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Db, type Tx, getDb } from "../db";
import { applications, masterData, requisitions, users } from "../db/schema";
import { warsawRunDate } from "../domain/daily-tasks";
import { OPEN_STATUSES } from "../domain/pipeline";
import { type ReportRequisition, ageOfRequisition, formatDays, timeToFill } from "../domain/reporting";
import { scopeApplicationsFor, scopeRequisitionsFor } from "../policy/filters";
import type { PolicyUser } from "../policy/permissions";
import { type CsvColumn, toCsv } from "./csv";

export const REQUISITION_COLUMNS: CsvColumn[] = [
  "Requisition number",
  "Title",
  "State",
  "Close reason",
  "Department",
  "Location",
  "Legal entity",
  "Hiring manager",
  "Recruiter",
  "Posting type",
  "Published",
  "Openings",
  "Hired",
  "Open applications",
  "Approved date",
  "Closed date",
  "Paused days",
  "Time to fill (days)",
  "Age (days)",
].map((header) => ({ header }));

export const PIPELINE_COLUMNS: CsvColumn[] = [
  "Application ID",
  "Requisition number",
  "Job title",
  "Status",
  "Reason code",
  "Source",
  "Pre-screening score",
  "Disqualified",
  "Applied date",
  "Disposition date",
  "Hired date",
  "Anonymized",
].map((header) => ({ header }));

const date = (value: Date | null) => (value ? warsawRunDate(value) : null);
/** Empty instead of "—" in a file. */
const daysCell = (value: number | null) => (value === null ? null : formatDays(value));

export type RequisitionExportRow = ReportRequisition & {
  reqNumber: string;
  title: string;
  department: string;
  location: string;
  legalEntity: string;
  hiringManager: string;
  recruiter: string;
  postingType: string;
  isPublished: boolean;
  openingsCount: number;
  hired: number;
  openApplications: number;
};

export function requisitionCsvRow(row: RequisitionExportRow, now: Date): (string | null)[] {
  return [
    row.reqNumber,
    row.title,
    row.state,
    row.closeReason,
    row.department,
    row.location,
    row.legalEntity,
    row.hiringManager,
    row.recruiter,
    row.postingType,
    String(row.isPublished),
    String(row.openingsCount),
    String(row.hired),
    String(row.openApplications),
    date(row.approvedAt),
    date(row.closedAt),
    Number(row.pausedDays).toFixed(2),
    daysCell(timeToFill(row)),
    daysCell(ageOfRequisition(row, now)),
  ];
}

export type PipelineExportRow = {
  id: string;
  reqNumber: string;
  title: string;
  status: string;
  reasonCode: string | null;
  source: string;
  prescreenScore: number;
  isDisqualified: boolean;
  appliedAt: Date;
  dispositionedAt: Date | null;
  hiredAt: Date | null;
  anonymizedAt: Date | null;
};

export function pipelineCsvRow(row: PipelineExportRow): (string | null)[] {
  return [
    row.id,
    row.reqNumber,
    row.title,
    row.status,
    row.reasonCode,
    row.source,
    String(row.prescreenScore),
    String(row.isDisqualified),
    date(row.appliedAt),
    date(row.dispositionedAt),
    date(row.hiredAt),
    String(row.anonymizedAt !== null),
  ];
}

const exportName = (prefix: string, now: Date) => `${prefix}-${warsawRunDate(now)}.csv`;

/** Every requisition in `user`'s scope, all states, by number (V10, D6). */
export async function exportRequisitions(user: PolicyUser, now = new Date(), db: Db | Tx = getDb()): Promise<{ csv: string; filename: string; rowCount: number }> {
  const department = alias(masterData, "department");
  const location = alias(masterData, "location");
  const legalEntity = alias(masterData, "legal_entity");
  const hiringManager = alias(users, "hiring_manager");
  const recruiter = alias(users, "recruiter");
  const hired = db
    .select({ requisitionId: applications.requisitionId, count: sql<number>`count(*)::int`.as("hired_count") })
    .from(applications)
    .where(eq(applications.status, "HIRED"))
    .groupBy(applications.requisitionId)
    .as("hired");
  const open = db
    .select({ requisitionId: applications.requisitionId, count: sql<number>`count(*)::int`.as("open_count") })
    .from(applications)
    .where(inArray(applications.status, [...OPEN_STATUSES]))
    .groupBy(applications.requisitionId)
    .as("open_applications");
  const rows = await db
    .select({
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      state: requisitions.state,
      closeReason: requisitions.closeReason,
      department: department.label,
      location: location.label,
      legalEntity: legalEntity.label,
      hiringManager: hiringManager.name,
      recruiter: recruiter.name,
      postingType: requisitions.postingType,
      isPublished: requisitions.isPublished,
      openingsCount: requisitions.openingsCount,
      hired: sql<number>`coalesce(${hired.count}, 0)::int`,
      openApplications: sql<number>`coalesce(${open.count}, 0)::int`,
      approvedAt: requisitions.approvedAt,
      closedAt: requisitions.closedAt,
      pausedDays: requisitions.pausedDays,
      onHoldSince: requisitions.onHoldSince,
    })
    .from(requisitions)
    .innerJoin(department, eq(department.id, requisitions.departmentId))
    .innerJoin(location, eq(location.id, requisitions.locationId))
    .innerJoin(legalEntity, eq(legalEntity.id, requisitions.legalEntityId))
    .innerJoin(hiringManager, eq(hiringManager.id, requisitions.hiringManagerId))
    .innerJoin(recruiter, eq(recruiter.id, requisitions.recruiterId))
    .leftJoin(hired, eq(hired.requisitionId, requisitions.id))
    .leftJoin(open, eq(open.requisitionId, requisitions.id))
    .where(scopeRequisitionsFor(user))
    .orderBy(asc(requisitions.reqNumber));
  return { csv: toCsv(REQUISITION_COLUMNS, rows.map((row) => requisitionCsvRow(row, now))), filename: exportName("requisitions", now), rowCount: rows.length };
}

/** Every application in `user`'s scope, anonymized ones included, without contact data (Q3). */
export async function exportPipeline(user: PolicyUser, now = new Date(), db: Db | Tx = getDb()): Promise<{ csv: string; filename: string; rowCount: number }> {
  const rows = await db
    .select({
      id: applications.id,
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      status: applications.status,
      reasonCode: applications.reasonCode,
      source: applications.source,
      prescreenScore: applications.prescreenScore,
      isDisqualified: applications.isDisqualified,
      appliedAt: applications.appliedAt,
      dispositionedAt: applications.dispositionedAt,
      hiredAt: applications.hiredAt,
      anonymizedAt: applications.anonymizedAt,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(scopeApplicationsFor(user), scopeRequisitionsFor(user)))
    .orderBy(asc(requisitions.reqNumber), asc(applications.appliedAt), asc(applications.id));
  return { csv: toCsv(PIPELINE_COLUMNS, rows.map(pipelineCsvRow)), filename: exportName("pipeline", now), rowCount: rows.length };
}

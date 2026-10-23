// Public career pages (ats-project-scope.md §5.2 Postings, §5.3 Job board,
// Accepting applications): the only read queries the public pages use. They
// select public columns only (title, department, location, description), so
// a later change to the requisition queries can't leak internal data.
import { and, asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { masterData, requisitions } from "../db/schema";
import { PRIVATE_SLUG_PATTERN } from "../domain/requisitions/slug";

export const JOBS_PAGE_SIZE = 20;
export const MAX_QUERY_LENGTH = 100;

const department = alias(masterData, "department");
const location = alias(masterData, "location");

/** Listed on the board: External and published (also in re-approval, §5.3). */
const listed = and(eq(requisitions.postingType, "EXTERNAL"), eq(requisitions.isPublished, true));

export const boardQuerySchema = z.object({
  q: z.string().optional(),
  location: z.string().optional(),
  department: z.string().optional(),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

export type BoardQuery = { q: string; location?: string; department?: string; page: number };

/** Trims and cuts the keyword input; empty filter values count as no filter. */
export function normalizeBoardQuery(raw: Record<string, string | string[] | undefined>): BoardQuery {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const parsed = boardQuerySchema.parse({ q: first(raw.q), location: first(raw.location), department: first(raw.department), page: first(raw.page) ?? 1 });
  return {
    q: (parsed.q ?? "").trim().slice(0, MAX_QUERY_LENGTH).trim(),
    location: parsed.location || undefined,
    department: parsed.department || undefined,
    page: parsed.page,
  };
}

/** `%`, `_` and `\` match literally in ILIKE … ESCAPE '\'. */
export function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The description as plain text for search: tags removed. */
const descriptionText = sql`regexp_replace(${requisitions.descriptionHtml}, '<[^>]*>', ' ', 'g')`;

function keywordCondition(q: string) {
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return and(
    ...words.map((word) => {
      const pattern = likePattern(word);
      return sql`(${requisitions.title} ILIKE ${pattern} ESCAPE '\\' OR ${descriptionText} ILIKE ${pattern} ESCAPE '\\')`;
    }),
  );
}

export type JobSummary = { id: string; title: string; department: string; location: string };

/** One page of the board, newest approval first, with search and filters (AND). */
export async function listPublicJobs(query: BoardQuery, db: Db | Tx = getDb()): Promise<{ jobs: JobSummary[]; total: number }> {
  const where = and(
    listed,
    keywordCondition(query.q),
    query.location ? eq(location.code, query.location) : undefined,
    query.department ? eq(department.code, query.department) : undefined,
  );
  const jobs = await db
    .select({ id: requisitions.id, title: requisitions.title, department: department.label, location: location.label })
    .from(requisitions)
    .innerJoin(department, eq(department.id, requisitions.departmentId))
    .innerJoin(location, eq(location.id, requisitions.locationId))
    .where(where)
    .orderBy(desc(requisitions.approvedAt), desc(requisitions.reqNumber))
    .limit(JOBS_PAGE_SIZE)
    .offset((query.page - 1) * JOBS_PAGE_SIZE);
  const [{ total }] = await db
    .select({ total: count() })
    .from(requisitions)
    .innerJoin(department, eq(department.id, requisitions.departmentId))
    .innerJoin(location, eq(location.id, requisitions.locationId))
    .where(where);
  return { jobs, total };
}

export type FilterOption = { code: string; label: string };

/** Filter options: the departments and locations of listed jobs, including deactivated records. */
export async function boardFilterOptions(db: Db | Tx = getDb()): Promise<{ locations: FilterOption[]; departments: FilterOption[] }> {
  const [locations, departments] = await Promise.all([
    db
      .selectDistinct({ code: masterData.code, label: masterData.label })
      .from(requisitions)
      .innerJoin(masterData, eq(masterData.id, requisitions.locationId))
      .where(listed)
      .orderBy(asc(masterData.label), asc(masterData.code)),
    db
      .selectDistinct({ code: masterData.code, label: masterData.label })
      .from(requisitions)
      .innerJoin(masterData, eq(masterData.id, requisitions.departmentId))
      .where(listed)
      .orderBy(asc(masterData.label), asc(masterData.code)),
  ]);
  return { locations, departments };
}

export type PublicJob = JobSummary & { descriptionHtml: string; isPublished: boolean };

async function findJob(condition: ReturnType<typeof and>, db: Db | Tx): Promise<PublicJob | undefined> {
  const [job] = await db
    .select({
      id: requisitions.id,
      title: requisitions.title,
      department: department.label,
      location: location.label,
      descriptionHtml: requisitions.descriptionHtml,
      isPublished: requisitions.isPublished,
    })
    .from(requisitions)
    .innerJoin(department, eq(department.id, requisitions.departmentId))
    .innerJoin(location, eq(location.id, requisitions.locationId))
    // Only requisitions approved at least once have a public page (§5.3).
    .where(and(condition, isNotNull(requisitions.approvedAt)));
  return job;
}

/** `/jobs/{id}`: External requisitions only. */
export function findExternalJob(id: string, db: Db | Tx = getDb()): Promise<PublicJob | undefined> {
  if (!z.uuid().safeParse(id).success) return Promise.resolve(undefined);
  return findJob(and(eq(requisitions.id, id), eq(requisitions.postingType, "EXTERNAL")), db);
}

/** `/jobs/p/{slug}`: Private requisitions only; a slug kept after a switch to External is 404. */
export function findPrivateJob(slug: string, db: Db | Tx = getDb()): Promise<PublicJob | undefined> {
  if (!PRIVATE_SLUG_PATTERN.test(slug)) return Promise.resolve(undefined);
  return findJob(and(eq(requisitions.privateSlug, slug), eq(requisitions.postingType, "PRIVATE")), db);
}

/** IDs of every listed job, for `/sitemap.xml`; never private ones. */
export async function sitemapJobIds(db: Db | Tx = getDb()): Promise<string[]> {
  const rows = await db.select({ id: requisitions.id }).from(requisitions).where(listed).orderBy(desc(requisitions.approvedAt));
  return rows.map((row) => row.id);
}

// Bulk email (ats-project-scope.md §5.4 Bulk actions, E3, E5, TO-01, TO-09):
// one active EMAIL template without a trigger status, sent as-is with its
// tokens resolved per application. Each application is queued in its own
// transaction through queueTemplateEmail; anonymized, unknown and
// out-of-scope applications and token errors are reported per application.
// Delivery happens later (email.send), so failures show on the timeline
// (E5). Logs carry IDs and counts only (M2).
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, withTransaction } from "../db";
import { applications, templates } from "../db/schema";
import { MissingTokenValueError, TokenNotAllowedError, UnclosedTokenError, UnknownTokenError } from "../domain/tokens";
import { logger } from "../logger";
import type { PolicyUser } from "../policy/permissions";
import { type BulkItemFailure, bulkFailure, isVisibleApplication, unexpectedFailure } from "../pipeline/bulk";
import { queueTemplateEmail } from ".";

export const bulkEmailSchema = z.object({ templateId: z.string().max(100), applicationIds: z.array(z.string().max(100)) }).strict();

export type BulkEmailResult = { applicationId: string; ok: true; emailLogId: string } | BulkItemFailure;

export type BulkTemplate = { id: string; name: string; subject: string; body: string };

const bulkTemplateWhere = and(eq(templates.type, "EMAIL"), eq(templates.isActive, true), isNull(templates.triggerStatus));

/** The bulk-email templates with their text, for the picker's read-only preview. */
export async function listBulkTemplates(): Promise<BulkTemplate[]> {
  const rows = await getDb()
    .select({ id: templates.id, name: templates.name, subject: templates.subject, body: templates.body })
    .from(templates)
    .where(bulkTemplateWhere)
    .orderBy(asc(templates.name));
  return rows.map((row) => ({ id: row.id, name: row.name, subject: row.subject ?? "", body: row.body ?? "" }));
}

/** Q5: the template still qualifies (exists, active, EMAIL, no trigger status) right before sending. */
async function usableTemplate(id: string): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  const [row] = await getDb().select({ id: templates.id }).from(templates).where(and(eq(templates.id, id), bulkTemplateWhere));
  return row !== undefined;
}

const TOKEN_ERRORS = [MissingTokenValueError, TokenNotAllowedError, UnknownTokenError, UnclosedTokenError];

/**
 * Queues the template to every visible, non-anonymized application (Q3),
 * one transaction each, in request order. Undefined when the template no
 * longer qualifies: then nothing is queued (409).
 */
export async function bulkSendEmail(
  user: PolicyUser,
  input: z.infer<typeof bulkEmailSchema>,
  options: { requestId?: string } = {},
): Promise<BulkEmailResult[] | undefined> {
  if (!(await usableTemplate(input.templateId))) return undefined;
  const results: BulkEmailResult[] = [];
  for (const applicationId of input.applicationIds) {
    if (!(await isVisibleApplication(user, applicationId))) {
      results.push(bulkFailure(applicationId, "notFound"));
      continue;
    }
    const [application] = await getDb().select({ anonymizedAt: applications.anonymizedAt }).from(applications).where(eq(applications.id, applicationId));
    if (application.anonymizedAt) {
      results.push(bulkFailure(applicationId, "anonymized"));
      continue;
    }
    try {
      const emailLogId = await withTransaction((tx) => queueTemplateEmail(tx, { templateId: input.templateId, applicationId }));
      results.push({ applicationId, ok: true, emailLogId });
    } catch (err) {
      if (TOKEN_ERRORS.some((type) => err instanceof type)) results.push(bulkFailure(applicationId, "tokenError", (err as Error).message));
      else results.push(unexpectedFailure(applicationId, err, options.requestId, "bulk email failed"));
    }
  }
  const queued = results.filter((result) => result.ok).length;
  logger.info({ user_id: user.id, template_id: input.templateId, requested: input.applicationIds.length, queued }, "bulk email");
  return results;
}

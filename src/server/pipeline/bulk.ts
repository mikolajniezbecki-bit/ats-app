// Bulk status moves (ats-project-scope.md §5.4 Bulk actions; tech-stack.md
// D3, D5, M2): one changeApplicationStatus call per application, each in
// its own transaction and with the version the list showed, one after the
// other. This file only orchestrates: it never writes `applications`, so
// every rule the service enforces (R1–R9, R11, L8, E8, E9) applies to bulk
// moves too: a hire that fills the requisition closes it (R6), and the
// later items in the batch are then refused. A refused, stale or failed
// application is reported and the others still change. Logs carry IDs and
// counts only.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Tx, getDb, withTransaction } from "../db";
import { applications } from "../db/schema";
import type { PipelineStatus } from "../domain/pipeline";
import { logger } from "../logger";
import { message } from "../messages";
import { scopeApplicationsFor } from "../policy/filters";
import { type PolicyUser, can } from "../policy/permissions";
import { MAX_STATUS_COMMENT_LENGTH, type StatusChangeResult, changeApplicationStatus } from ".";

export const MAX_BULK_ITEMS = 100;

export type BulkItemFailure = { applicationId: string; ok: false; code: string; message: string };

/** 400 codes for a bulk request as a whole, with their `Bulk.errors` texts. */
export type BulkInputError = "tooMany" | "empty" | "duplicate" | "invalid";

const statusSchema = z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]);

export const bulkStatusSchema = z
  .object({
    toStatus: statusSchema,
    comment: z.string().trim().max(MAX_STATUS_COMMENT_LENGTH).optional(),
    items: z.array(z.object({ applicationId: z.string().max(100), version: z.number().int().min(1) }).strict()),
  })
  .strict();

/** The input error of a parsed request's ID list, if any: empty, over 100, or a duplicate ID. */
export function bulkIdsError(ids: readonly string[]): BulkInputError | undefined {
  if (ids.length === 0) return "empty";
  if (ids.length > MAX_BULK_ITEMS) return "tooMany";
  if (new Set(ids).size !== ids.length) return "duplicate";
  return undefined;
}

export function bulkFailure(applicationId: string, code: string, text = message(`Bulk.errors.${code}`)): BulkItemFailure {
  return { applicationId, ok: false, code, message: text };
}

/** Whether `user` may see application `id` (V9); unknown and out-of-scope IDs look the same. */
export async function isVisibleApplication(user: PolicyUser, id: string): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  const [row] = await getDb().select({ id: applications.id }).from(applications).where(and(scopeApplicationsFor(user), eq(applications.id, id)));
  return row !== undefined;
}

/** An unexpected error on one item: rolled back, logged with its ID, reported with the request ID. */
export function unexpectedFailure(applicationId: string, err: unknown, requestId: string | undefined, event: string): BulkItemFailure {
  logger.error({ err, application_id: applicationId, request_id: requestId }, event);
  return bulkFailure(applicationId, "failed", message("Bulk.errors.failed", { requestId: requestId ?? "—" }));
}

export type BulkStatusResult = { applicationId: string; ok: true; status: PipelineStatus; version: number } | BulkItemFailure;

type ChangeStatus = (tx: Tx, input: Parameters<typeof changeApplicationStatus>[1]) => Promise<StatusChangeResult>;

/**
 * Moves each item in request order, each in a new transaction (Q1). The
 * comment goes on every moved application's history (Q7). `change` is the
 * service; tests pass a wrapper that fails on purpose.
 */
export async function bulkChangeStatus(
  user: PolicyUser,
  input: z.infer<typeof bulkStatusSchema>,
  options: { requestId?: string; change?: ChangeStatus; isVisible?: typeof isVisibleApplication } = {},
): Promise<BulkStatusResult[]> {
  const change = options.change ?? changeApplicationStatus;
  const isVisible = options.isVisible ?? isVisibleApplication;
  const results: BulkStatusResult[] = [];
  for (const { applicationId, version } of input.items) {
    // Everything per item, the visibility check included, is inside the try:
    // any error is that item's failure, and the rest still run.
    try {
      if (!(await isVisible(user, applicationId))) {
        results.push(bulkFailure(applicationId, "notFound"));
        continue;
      }
      const result = await withTransaction((tx) =>
        change(tx, {
          applicationId,
          toStatus: input.toStatus,
          version,
          comment: input.comment,
          actor: { id: user.id },
          canCorrectHired: can(user, "application.correctHired"),
        }),
      );
      results.push(result.ok ? { applicationId, ok: true, status: result.status, version: result.version } : bulkFailure(applicationId, result.reason, result.message));
    } catch (err) {
      results.push(unexpectedFailure(applicationId, err, options.requestId, "bulk status change failed"));
    }
  }
  const moved = results.filter((result) => result.ok).length;
  logger.info({ user_id: user.id, to_status: input.toStatus, requested: input.items.length, moved }, "bulk status change");
  return results;
}

// Constraints of the recruiting tables (ats-project-scope.md §7, tables
// 5–17). Each test runs in a rolled-back transaction (see helpers.ts), except
// the req_number tests, which need committed rows or a fresh database.
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, inject, it } from "vitest";
import { type Tx, createPool, withTransaction } from "@/server/db";
import * as schema from "@/server/db/schema";
import {
  applications,
  emailLog,
  files,
  interviewParticipants,
  interviewScorecards,
  interviews,
  offers,
  prescreenQuestions,
} from "@/server/db/schema";
import { TEMPLATE_DATABASE, WORKER_DATABASE_PREFIX, databaseUrlFor, quoteIdent, withAdminClient } from "./database";
import {
  applicationValues,
  insertApplication,
  insertInterview,
  insertRequisition,
  insertUser,
  offerValues,
} from "./fixtures";
import { PG, expectPgError, rolledBack, unique } from "./helpers";

/** Runs `fn` against a new database cloned from the migrated template, then drops it. */
async function inFreshDatabase(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const baseUrl = inject("integrationDatabaseUrl");
  // The worker prefix makes the global setup drop it if a run is interrupted.
  const database = `${WORKER_DATABASE_PREFIX}fresh_${process.env.VITEST_POOL_ID ?? "1"}`;
  await withAdminClient(baseUrl, (client) =>
    client.query(`CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(TEMPLATE_DATABASE)}`),
  );
  const pool = createPool(databaseUrlFor(baseUrl, database), { max: 1 });
  try {
    await drizzle({ client: pool, schema }).transaction(fn);
  } finally {
    await pool.end();
    await withAdminClient(baseUrl, (client) => client.query(`DROP DATABASE ${quoteIdent(database)} WITH (FORCE)`));
  }
}

describe("requisitions.req_number", () => {
  it("numbers the first two requisitions of a fresh database REQ-00001 and REQ-00002", () =>
    inFreshDatabase(async (tx) => {
      const first = await insertRequisition(tx);
      const second = await insertRequisition(tx);
      expect([first.reqNumber, second.reqNumber]).toEqual(["REQ-00001", "REQ-00002"]);
    }));

  it("gives requisitions inserted by two concurrent transactions different numbers", async () => {
    // Both transactions insert, then wait for each other before committing,
    // so they are open at the same time on separate connections.
    let arrived = 0;
    let release!: () => void;
    const bothInserted = new Promise<void>((resolve) => (release = resolve));
    const insertAndWait = () =>
      withTransaction(async (tx) => {
        const row = await insertRequisition(tx);
        if (++arrived === 2) release();
        await bothInserted;
        return row.reqNumber;
      });

    const [a, b] = await Promise.all([insertAndWait(), insertAndWait()]);
    expect(a).toMatch(/^REQ-\d{5}$/);
    expect(b).toMatch(/^REQ-\d{5}$/);
    expect(a).not.toBe(b);
  });

  it("never reuses the number of a rolled-back insert", async () => {
    let rolledBackNumber = "";
    await rolledBack(async (tx) => {
      rolledBackNumber = (await insertRequisition(tx)).reqNumber;
    });
    const next = await withTransaction(async (tx) => (await insertRequisition(tx)).reqNumber);
    expect(next).not.toBe(rolledBackNumber);
    expect(next > rolledBackNumber).toBe(true);
  });

  it("rejects an explicit duplicate req_number", () =>
    rolledBack(async (tx) => {
      const existing = await insertRequisition(tx);
      await expectPgError(tx, (sp) => insertRequisition(sp, { reqNumber: existing.reqNumber }), {
        code: PG.uniqueViolation,
        constraint: "requisitions_req_number_unique",
      });
    }));
});

describe("requisitions", () => {
  it("applies the defaults", () =>
    rolledBack(async (tx) => {
      const row = await insertRequisition(tx);
      expect(row).toMatchObject({
        state: "DRAFT",
        isPublished: false,
        pausedDays: "0.00",
        customFieldsJson: {},
        descriptionHtml: "",
        version: 1,
        templateId: null,
      });
    }));

  it("rejects openings_count = 0", () =>
    rolledBack(async (tx) => {
      await expectPgError(tx, (sp) => insertRequisition(sp, { openingsCount: 0 }), {
        code: PG.checkViolation,
        constraint: "requisitions_openings_count_check",
      });
    }));

  it("rejects state = 'OPEN'", () =>
    rolledBack(async (tx) => {
      await expectPgError(tx, (sp) => insertRequisition(sp, { state: sql`'OPEN'` as never }), {
        code: PG.checkViolation,
        constraint: "requisitions_state_check",
      });
    }));

  it("rejects a duplicate private_slug but accepts several NULL slugs", () =>
    rolledBack(async (tx) => {
      const slug = unique("slug");
      await insertRequisition(tx, { postingType: "PRIVATE", privateSlug: slug });
      await insertRequisition(tx, { privateSlug: null });
      await insertRequisition(tx, { privateSlug: null });
      await expectPgError(tx, (sp) => insertRequisition(sp, { postingType: "PRIVATE", privateSlug: slug }), {
        code: PG.uniqueViolation,
        constraint: "requisitions_private_slug_unique",
      });
    }));
});

describe("prescreen_questions", () => {
  it("rejects weight = -1", () =>
    rolledBack(async (tx) => {
      const requisition = await insertRequisition(tx);
      await expectPgError(
        tx,
        (sp) =>
          sp.insert(prescreenQuestions).values({
            requisitionId: requisition.id,
            questionText: "Do you have a work permit?",
            questionType: "YES_NO",
            weight: -1,
          }),
        { code: PG.checkViolation, constraint: "prescreen_questions_weight_check" },
      );
    }));
});

describe("applications", () => {
  const PERSONAL_DATA = { code: PG.checkViolation, constraint: "applications_personal_data_check" };

  for (const column of ["firstName", "lastName", "email", "emailHash", "phone"] as const) {
    it(`rejects a NULL ${column} while not anonymized`, () =>
      rolledBack(async (tx) => {
        const requisition = await insertRequisition(tx);
        await expectPgError(
          tx,
          (sp) => sp.insert(applications).values({ ...applicationValues(requisition.id), [column]: null }),
          PERSONAL_DATA,
        );
      }));
  }

  it("accepts all five personal-data columns NULL once anonymized", () =>
    rolledBack(async (tx) => {
      const row = await insertApplication(tx, {
        firstName: null,
        lastName: null,
        email: null,
        emailHash: null,
        phone: null,
        anonymizedAt: new Date(),
      });
      expect(row.email).toBeNull();
    }));

  it("applies the defaults", () =>
    rolledBack(async (tx) => {
      const row = await insertApplication(tx);
      expect(row).toMatchObject({
        status: "APPLIED",
        prescreenScore: 0,
        isDisqualified: false,
        version: 1,
        candidateId: null,
        reasonCode: null,
      });
      expect(row.appliedAt).toBeInstanceOf(Date);
    }));
});

describe("interviews", () => {
  it("rejects a duplicate ics_uid", () =>
    rolledBack(async (tx) => {
      const existing = await insertInterview(tx);
      await expectPgError(tx, (sp) => sp.insert(interviews).values({ ...existing, id: crypto.randomUUID() }), {
        code: PG.uniqueViolation,
        constraint: "interviews_ics_uid_unique",
      });
    }));

  it("rejects a second participant row for the same user", () =>
    rolledBack(async (tx) => {
      const interview = await insertInterview(tx);
      const user = await insertUser(tx, "INTERVIEWER");
      await tx.insert(interviewParticipants).values({ interviewId: interview.id, userId: user.id });
      await expectPgError(
        tx,
        (sp) => sp.insert(interviewParticipants).values({ interviewId: interview.id, userId: user.id }),
        { code: PG.uniqueViolation, constraint: "interview_participants_interview_id_user_id_unique" },
      );
    }));
});

describe("interview_scorecards", () => {
  async function scorecard(tx: Tx) {
    const interview = await insertInterview(tx);
    const interviewer = await insertUser(tx, "INTERVIEWER");
    return (overallRating: number) => ({
      interviewId: interview.id,
      interviewerId: interviewer.id,
      overallRating,
      thumbsUp: true,
    });
  }

  it("rejects a second scorecard by the same interviewer", () =>
    rolledBack(async (tx) => {
      const values = await scorecard(tx);
      await tx.insert(interviewScorecards).values(values(4));
      await expectPgError(tx, (sp) => sp.insert(interviewScorecards).values(values(5)), {
        code: PG.uniqueViolation,
        constraint: "interview_scorecards_interview_id_interviewer_id_unique",
      });
    }));

  it("rejects an overall_rating of 0 or 6 and accepts 1 and 5", () =>
    rolledBack(async (tx) => {
      const RATING = { code: PG.checkViolation, constraint: "interview_scorecards_overall_rating_check" };
      for (const rating of [0, 6]) {
        const values = await scorecard(tx);
        await expectPgError(tx, (sp) => sp.insert(interviewScorecards).values(values(rating)), RATING);
      }
      for (const rating of [1, 5]) {
        const values = await scorecard(tx);
        await tx.insert(interviewScorecards).values(values(rating));
      }
    }));
});

describe("offers", () => {
  const APPROVER = { code: PG.checkViolation, constraint: "offers_approver_id_check" };
  const CURRENCY = { code: PG.checkViolation, constraint: "offers_currency_check" };

  it("accepts a NULL approver_id for DRAFT and WITHDRAWN offers", () =>
    rolledBack(async (tx) => {
      for (const approvalStatus of ["DRAFT", "WITHDRAWN"] as const) {
        await tx.insert(offers).values({ ...(await offerValues(tx)), approvalStatus, approverId: null });
      }
    }));

  it("rejects a NULL approver_id for PENDING, APPROVED and REJECTED offers", () =>
    rolledBack(async (tx) => {
      for (const approvalStatus of ["PENDING", "APPROVED", "REJECTED"] as const) {
        const values = await offerValues(tx);
        await expectPgError(tx, (sp) => sp.insert(offers).values({ ...values, approvalStatus, approverId: null }), APPROVER);
      }
    }));

  it("rejects a currency that is not three upper-case letters", () =>
    rolledBack(async (tx) => {
      for (const currency of ["eur", "EURO"]) {
        const values = await offerValues(tx);
        await expectPgError(tx, (sp) => sp.insert(offers).values({ ...values, currency }), CURRENCY);
      }
    }));

  it("applies the defaults", () =>
    rolledBack(async (tx) => {
      const [row] = await tx.insert(offers).values(await offerValues(tx)).returning();
      expect(row).toMatchObject({ approvalStatus: "DRAFT", candidateResponse: "PENDING", version: 1, salary: "10000.00" });
    }));
});

describe("files", () => {
  const file = (storageKey: string) => ({
    ownerType: "APPLICATION" as const,
    ownerId: crypto.randomUUID(),
    kind: "CV" as const,
    mime: "application/pdf",
    sizeBytes: 1024,
    storageKey,
  });

  it("rejects status = 'INFECTED'", () =>
    rolledBack(async (tx) => {
      await expectPgError(
        tx,
        (sp) => sp.insert(files).values({ ...file(unique("key")), status: sql`'INFECTED'` as never }),
        { code: PG.checkViolation, constraint: "files_status_check" },
      );
    }));

  it("rejects a duplicate storage_key", () =>
    rolledBack(async (tx) => {
      const key = unique("key");
      const [row] = await tx.insert(files).values(file(key)).returning();
      expect(row).toMatchObject({ status: "CLEAN", originalName: null });
      await expectPgError(tx, (sp) => sp.insert(files).values(file(key)), {
        code: PG.uniqueViolation,
        constraint: "files_storage_key_unique",
      });
    }));
});

describe("email_log", () => {
  const email = { audience: "CANDIDATE" as const, status: "QUEUED" as const };

  it("rejects direction = 'INBOUND'", () =>
    rolledBack(async (tx) => {
      await expectPgError(tx, (sp) => sp.insert(emailLog).values({ ...email, direction: sql`'INBOUND'` as never }), {
        code: PG.checkViolation,
        constraint: "email_log_direction_check",
      });
    }));

  it("stores {} when attachment_file_ids is omitted", () =>
    rolledBack(async (tx) => {
      const [{ id }] = await tx.insert(emailLog).values(email).returning({ id: emailLog.id });
      const [row] = await tx
        .select({ ids: sql<string>`${emailLog.attachmentFileIds}::text`, direction: emailLog.direction })
        .from(emailLog)
        .where(eq(emailLog.id, id));
      expect(row).toEqual({ ids: "{}", direction: "OUTBOUND" });
    }));
});

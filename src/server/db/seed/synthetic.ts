// The synthetic demo data of `db:seed` (tech-stack.md D8, ats-project-scope.md
// C3; task 42). Runs inside the seed's transaction, under its advisory lock,
// and only when no requisition exists yet. Rows are inserted directly where a
// service would queue emails or jobs; the rules come from the domain code
// (scoring, email hash, sanitizer, offer letter renderer), so the demo can
// continue through the normal UI. Every date is within the last 60 days of
// the seed run (Q4). Files are uploaded before the transaction commits; the
// caller deletes them again if it fails (Q3). Output is counts only (M2).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { StorageService } from "../../adapters/storage";
import { warsawRunDate } from "../../domain/daily-tasks";
import { computeEmailHash } from "../../domain/apply";
import { type Answer, type ScoredQuestion, scorePrescreen } from "../../domain/prescreen/scoring";
import { sanitizeDescription } from "../../domain/requisitions/description";
import { generatePrivateSlug } from "../../domain/requisitions/slug";
import { formatDate } from "../../domain/tokens/format";
import { offerTokenValues } from "../../offers/letter";
import { renderOfferLetter } from "../../pdf";
import { getSetting } from "../../settings";
import type { Tx } from "../index";
import {
  applicationHistory,
  applications,
  approvalEvents,
  files,
  interviewParticipants,
  interviewScorecards,
  interviews,
  masterData,
  offers,
  prescreenAnswers,
  prescreenQuestions,
  requisitionHistory,
  requisitions,
  templates,
  users,
} from "../schema";
import { SYNTHETIC_PDF_NOTICE, syntheticCandidate } from "./synthetic-identities";

const DAY = 86_400_000;

export type SyntheticCounts = { skipped: true } | { skipped: false; requisitions: number; applications: number; files: number };

type Deps = { storage: StorageService; emailHashKey: string; domain: string; now: Date; uploadedKeys: string[] };
type RequisitionRow = typeof requisitions.$inferSelect;
type ApplicationStatus = (typeof applications.$inferSelect)["status"];
type ReasonCode = (typeof applications.$inferSelect)["reasonCode"];

/** One page saying what the file is and that it is synthetic. */
async function samplePdf(title: string, lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer("ATS synthetic demo data");
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText(title, { x: 56, y: 770, size: 20, font: bold });
  page.drawText(SYNTHETIC_PDF_NOTICE, { x: 56, y: 740, size: 12, font: bold });
  lines.forEach((line, i) => page.drawText(line, { x: 56, y: 700 - i * 18, size: 11, font }));
  return pdf.save();
}

/**
 * Creates the demo when the database has no requisition yet. The base seed
 * (users, master data, templates, settings) must already be in `tx`.
 */
export async function seedSynthetic(tx: Tx, deps: Deps): Promise<SyntheticCounts> {
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(requisitions);
  if (count > 0) return { skipped: true };
  const builder = new DemoBuilder(tx, deps);
  await builder.build();
  return { skipped: false, ...builder.counts };
}

class DemoBuilder {
  readonly counts = { requisitions: 0, applications: 0, files: 0 };
  private candidateIndex = 0;
  private staff!: Record<"admin" | "recruiter" | "hm" | "interviewer", string>;
  private md!: Record<string, string>;
  private requisitionTemplateId!: string;
  private offerTemplateId!: string;
  private consentVersion!: string;

  constructor(
    private readonly tx: Tx,
    private readonly deps: Deps,
  ) {}

  private ago(days: number, hours = 0): Date {
    return new Date(this.deps.now.getTime() - days * DAY - hours * 3_600_000);
  }

  private async load() {
    const staff = await this.tx.select({ id: users.id, email: users.email }).from(users);
    const byLocal = (local: string) => {
      const found = staff.find((user) => user.email === `${local}@${this.deps.domain}`);
      if (!found) throw new Error(`demo user ${local} missing`);
      return found.id;
    };
    this.staff = { admin: byLocal("admin"), recruiter: byLocal("recruiter"), hm: byLocal("hm"), interviewer: byLocal("interviewer") };
    const records = await this.tx.select({ id: masterData.id, type: masterData.type, code: masterData.code }).from(masterData).where(eq(masterData.isActive, true));
    this.md = Object.fromEntries(records.map((record) => [`${record.type}:${record.code}`, record.id]));
    const [requisitionTemplate] = await this.tx.select({ id: templates.id }).from(templates).where(and(eq(templates.type, "REQUISITION"), eq(templates.name, "Standard requisition")));
    const [offerTemplate] = await this.tx.select({ id: templates.id }).from(templates).where(and(eq(templates.type, "OFFER"), eq(templates.name, "Default offer letter")));
    this.requisitionTemplateId = requisitionTemplate.id;
    this.offerTemplateId = offerTemplate.id;
    this.consentVersion = await getSetting("PRIVACY_STATEMENT_VERSION", this.tx);
  }

  private masterId(type: string, code: string): string {
    const id = this.md[`${type}:${code}`];
    if (!id) throw new Error(`master data ${type}:${code} missing or inactive`);
    return id;
  }

  private async upload(bytes: Uint8Array): Promise<string> {
    const { key } = await this.deps.storage.upload(bytes, "application/pdf");
    this.deps.uploadedKeys.push(key);
    this.counts.files += 1;
    return key;
  }

  private async storeFile(ownerType: "APPLICATION" | "OFFER", ownerId: string, kind: "CV" | "COVER_LETTER" | "OFFER_LETTER", bytes: Uint8Array, originalName: string, createdAt: Date) {
    const storageKey = await this.upload(bytes);
    const [row] = await this.tx
      .insert(files)
      .values({ ownerType, ownerId, kind, mime: "application/pdf", sizeBytes: bytes.length, originalName, storageKey, status: "CLEAN", createdAt, updatedAt: createdAt })
      .returning({ id: files.id });
    return row.id;
  }

  async build() {
    await this.load();
    const { recruiter, hm } = this.staff;

    // 1. Requisitions in every state (Q6: the demo Hiring Manager approves the pending ones).
    await this.requisition({ title: "Data Analyst (synthetic)", state: "DRAFT", created: 3, description: "" });
    await this.requisition({ title: "Finance Controller (synthetic)", state: "PENDING_APPROVAL", created: 6, submitted: 2, department: "FINANCE", location: "KRAKOW" });
    const reApproval = await this.requisition({ title: "Sales Representative (synthetic)", state: "PENDING_APPROVAL", created: 50, approved: 45, reApproval: 1, department: "SALES", openings: 2 });
    const external = await this.requisition({ title: "Backend Engineer (synthetic)", state: "APPROVED", created: 40, approved: 35, openings: 3 });
    const privateJob = await this.requisition({ title: "Product Designer (synthetic)", state: "APPROVED", created: 38, approved: 33, postingType: "PRIVATE", location: "REMOTE", openings: 2 });
    const onHold = await this.requisition({ title: "People Partner (synthetic)", state: "ON_HOLD", created: 45, approved: 40, onHold: 5, department: "PEOPLE", legalEntity: "DEMO_DE" });
    const filled = await this.requisition({ title: "QA Engineer (synthetic)", state: "CLOSED", created: 58, approved: 55, closed: 8, closeReason: "FILLED", openings: 1 });
    const cancelled = await this.requisition({ title: "Account Manager (synthetic)", state: "CLOSED", created: 57, approved: 52, closed: 12, closeReason: "CANCELLED", department: "SALES" });

    // 2. Applications in every status; one candidate applies twice (email_hash grouping).
    const repeat = syntheticCandidate(this.candidateIndex++);
    await this.application(external, { status: "APPLIED", applied: 2 });
    await this.application(external, { status: "APPLIED", applied: 1, answers: "partial" });
    await this.application(external, { status: "SCREENING", applied: 9, candidate: repeat, coverLetter: true });
    const interview = await this.application(external, { status: "INTERVIEW", applied: 14 });
    const draftOffer = await this.application(external, { status: "OFFER", applied: 25 });
    const pendingOffer = await this.application(external, { status: "OFFER", applied: 24, coverLetter: true });
    const sentOffer = await this.application(external, { status: "OFFER", applied: 23 });
    const hiredExternal = await this.application(external, { status: "HIRED", applied: 30, exported: true });
    await this.application(external, { status: "REJECTED", applied: 10, reasonCode: "DISQUALIFIED" });
    await this.application(external, { status: "WITHDRAWN", applied: 12 });

    await this.application(privateJob, { status: "APPLIED", applied: 3 });
    const privateInterview = await this.application(privateJob, { status: "INTERVIEW", applied: 15, coverLetter: true });
    const hiredPrivate = await this.application(privateJob, { status: "HIRED", applied: 28, exported: false });

    await this.application(reApproval, { status: "SCREENING", applied: 20 });
    await this.application(reApproval, { status: "APPLIED", applied: 4 });

    await this.application(onHold, { status: "SCREENING", applied: 18, candidate: repeat });
    await this.application(onHold, { status: "REJECTED", applied: 22, reasonCode: "OTHER" });

    const hiredFilled = await this.application(filled, { status: "HIRED", applied: 40, exported: true, decided: 8 });
    await this.application(filled, { status: "REJECTED", applied: 35, reasonCode: "REQ_FILLED", decided: 8 });
    await this.application(filled, { status: "REJECTED", applied: 30, reasonCode: "REQ_FILLED", decided: 8 });

    await this.application(cancelled, { status: "REJECTED", applied: 40, reasonCode: "REQ_CANCELLED", decided: 12 });
    await this.application(cancelled, { status: "WITHDRAWN", applied: 45, decided: 20 });

    // 3. Interviews (I1, I7, I9): future, past "awaiting outcome" (the Interviewer's scorecard to fill), completed.
    await this.interview(interview, { at: -3, status: "SCHEDULED", participants: [recruiter, this.staff.interviewer] });
    await this.interview(interview, { at: 2, status: "SCHEDULED", participants: [this.staff.interviewer] });
    await this.interview(privateInterview, { at: 5, status: "COMPLETED", participants: [this.staff.interviewer, hm], scorecards: [{ by: hm, rating: 4, thumbsUp: true }] });
    for (const app of [draftOffer, pendingOffer, sentOffer, hiredExternal, hiredPrivate, hiredFilled]) {
      await this.interview(app, { at: 12, status: "COMPLETED", participants: [hm, this.staff.interviewer], scorecards: [{ by: this.staff.interviewer, rating: 5, thumbsUp: true }] });
    }

    // 4. Offers (Q2): a draft, one awaiting the demo Hiring Manager, a sent one awaiting the candidate, and the hires' accepted ones.
    await this.offer(draftOffer, { status: "DRAFT", created: 2 });
    await this.offer(pendingOffer, { status: "PENDING", created: 3 });
    await this.offer(sentOffer, { status: "APPROVED", created: 6, sent: 4 });
    await this.offer(hiredExternal, { status: "APPROVED", created: 20, sent: 18, accepted: 15 });
    await this.offer(hiredPrivate, { status: "APPROVED", created: 18, sent: 16, accepted: 12 });
    await this.offer(hiredFilled, { status: "APPROVED", created: 20, sent: 17, accepted: 14 });
  }

  // -- Requisitions -----------------------------------------------------------

  private async requisition(spec: {
    title: string;
    state: RequisitionRow["state"];
    created: number;
    submitted?: number;
    approved?: number;
    reApproval?: number;
    onHold?: number;
    closed?: number;
    closeReason?: "FILLED" | "CANCELLED";
    description?: string;
    department?: string;
    location?: string;
    legalEntity?: string;
    postingType?: "EXTERNAL" | "PRIVATE";
    openings?: number;
  }): Promise<RequisitionRow> {
    const { recruiter, hm } = this.staff;
    const postingType = spec.postingType ?? "EXTERNAL";
    const departmentId = this.masterId("DEPARTMENT", spec.department ?? "ENGINEERING");
    const legalEntityId = this.masterId("LEGAL_ENTITY", spec.legalEntity ?? "DEMO_PL");
    const openings = spec.openings ?? 1;
    const approvedAt = spec.approved !== undefined ? this.ago(spec.approved) : null;
    const reApproval = spec.reApproval !== undefined;
    const submittedAt = reApproval ? this.ago(spec.reApproval!) : spec.submitted !== undefined ? this.ago(spec.submitted) : spec.approved !== undefined ? this.ago(spec.approved + 1) : null;
    const created = this.ago(spec.created);
    const description =
      spec.description ??
      sanitizeDescription(
        `<p>This is a <strong>synthetic</strong> job posting for the ATS demo.</p><ul><li>Work with a friendly, fictional team</li><li>No real position exists</li></ul>`,
      );
    const [row] = await this.tx
      .insert(requisitions)
      .values({
        title: spec.title,
        templateId: this.requisitionTemplateId,
        departmentId,
        locationId: this.masterId("LOCATION", spec.location ?? "WARSAW"),
        legalEntityId,
        hiringManagerId: hm,
        recruiterId: recruiter,
        createdByUserId: recruiter,
        submittedByUserId: submittedAt ? recruiter : null,
        submittedAt,
        approverId: submittedAt ? hm : null,
        state: spec.state,
        closeReason: spec.closeReason ?? null,
        openingsCount: openings,
        descriptionHtml: description,
        customFieldsJson: { employment_type: "FULL_TIME", seniority: "MID", remote_allowed: postingType === "PRIVATE" },
        postingType,
        privateSlug: postingType === "PRIVATE" ? generatePrivateSlug() : null,
        // L2: a re-approval keeps the posting published; ON_HOLD and CLOSED aren't.
        isPublished: spec.state === "APPROVED" || reApproval,
        approvedAt,
        // L2: the values before the increase of openings_count.
        previousL2ValuesJson: reApproval ? { openings_count: openings - 1, department_id: departmentId, hiring_manager_id: hm, legal_entity_id: legalEntityId } : null,
        onHoldSince: spec.onHold !== undefined ? this.ago(spec.onHold) : null,
        pausedDays: "0.00",
        closedAt: spec.closed !== undefined ? this.ago(spec.closed) : null,
        createdAt: created,
        updatedAt: created,
      })
      .returning();
    this.counts.requisitions += 1;

    // L11 history: creation, submission, approval, then the later state changes.
    const history: (typeof requisitionHistory.$inferInsert)[] = [{ requisitionId: row.id, event: "STATE_CHANGE", field: "state", oldValue: null, newValue: "DRAFT", userId: recruiter, createdAt: created }];
    const state = (from: string, to: string, at: Date, userId = recruiter) =>
      history.push({ requisitionId: row.id, event: "STATE_CHANGE", field: "state", oldValue: from, newValue: to, userId, createdAt: at });
    const events: (typeof approvalEvents.$inferInsert)[] = [];
    if (approvedAt) {
      const firstSubmit = new Date(approvedAt.getTime() - DAY);
      state("DRAFT", "PENDING_APPROVAL", firstSubmit);
      state("PENDING_APPROVAL", "APPROVED", approvedAt, hm);
      events.push({ subjectType: "REQUISITION", subjectId: row.id, event: "SUBMITTED", actorUserId: recruiter, toApproverId: hm, createdAt: firstSubmit });
      events.push({ subjectType: "REQUISITION", subjectId: row.id, event: "APPROVED", actorUserId: hm, createdAt: approvedAt });
    } else if (submittedAt) {
      state("DRAFT", "PENDING_APPROVAL", submittedAt);
      events.push({ subjectType: "REQUISITION", subjectId: row.id, event: "SUBMITTED", actorUserId: recruiter, toApproverId: hm, createdAt: submittedAt });
    }
    if (reApproval) {
      history.push({ requisitionId: row.id, event: "FIELD_CHANGE", field: "openings_count", oldValue: String(openings - 1), newValue: String(openings), userId: recruiter, createdAt: submittedAt! });
      state("APPROVED", "PENDING_APPROVAL", submittedAt!);
      events.push({ subjectType: "REQUISITION", subjectId: row.id, event: "SUBMITTED", actorUserId: recruiter, toApproverId: hm, createdAt: submittedAt! });
    }
    if (spec.onHold !== undefined) state("APPROVED", "ON_HOLD", this.ago(spec.onHold));
    if (spec.closed !== undefined) {
      const closedAt = this.ago(spec.closed);
      // R6: the last hire closes a FILLED requisition; a CANCELLED one is closed by hand with a comment (L6).
      state("APPROVED", "CLOSED", closedAt);
      history.push({
        requisitionId: row.id,
        event: "FIELD_CHANGE",
        field: "close_reason",
        oldValue: null,
        newValue: spec.closeReason!,
        userId: recruiter,
        comment: spec.closeReason === "CANCELLED" ? "Synthetic: budget moved to another team." : null,
        createdAt: closedAt,
      });
    }
    await this.tx.insert(requisitionHistory).values(history);
    if (events.length > 0) await this.tx.insert(approvalEvents).values(events);
    if (approvedAt) await this.questions(row.id, approvedAt);
    return row;
  }

  private readonly questionsByRequisition = new Map<string, ScoredQuestion[]>();

  /** S1–S4: a disqualifying YES_NO, a scored SINGLE and an informational TEXT question. */
  private async questions(requisitionId: string, at: Date) {
    const rows = await this.tx
      .insert(prescreenQuestions)
      .values([
        {
          requisitionId,
          questionText: "Are you allowed to work in the European Union?",
          questionType: "YES_NO",
          optionsJson: [
            { code: "YES", label: "Yes" },
            { code: "NO", label: "No" },
          ],
          weight: 5,
          scoringAnswer: "YES",
          disqualifyingAnswer: "NO",
          sortOrder: 1,
          createdAt: at,
          updatedAt: at,
        },
        {
          requisitionId,
          questionText: "How many years of relevant experience do you have?",
          questionType: "SINGLE",
          optionsJson: [
            { code: "LT2", label: "Less than 2" },
            { code: "2TO5", label: "2 to 5" },
            { code: "GT5", label: "More than 5" },
          ],
          weight: 3,
          scoringAnswer: "GT5",
          disqualifyingAnswer: null,
          sortOrder: 2,
          createdAt: at,
          updatedAt: at,
        },
        { requisitionId, questionText: "Anything else you would like to tell us?", questionType: "TEXT", weight: 0, sortOrder: 3, createdAt: at, updatedAt: at },
      ])
      .returning();
    this.questionsByRequisition.set(
      requisitionId,
      rows.map((row) => ({
        id: row.id,
        questionType: row.questionType,
        options: row.optionsJson as { code: string; label: string }[],
        weight: row.weight,
        scoringAnswer: row.scoringAnswer as ScoredQuestion["scoringAnswer"],
        disqualifyingAnswer: row.disqualifyingAnswer as ScoredQuestion["disqualifyingAnswer"],
        isActive: row.isActive,
      })),
    );
  }

  // -- Applications -----------------------------------------------------------

  private async application(
    requisition: RequisitionRow,
    spec: {
      status: ApplicationStatus;
      applied: number;
      reasonCode?: ReasonCode;
      candidate?: ReturnType<typeof syntheticCandidate>;
      coverLetter?: boolean;
      answers?: "all" | "partial";
      exported?: boolean;
      /** Days ago of the final decision; defaults to a day after the last step. */
      decided?: number;
    },
  ) {
    const candidate = spec.candidate ?? syntheticCandidate(this.candidateIndex++);
    const appliedAt = this.ago(spec.applied);
    const disqualified = spec.reasonCode === "DISQUALIFIED";
    const questions = this.questionsByRequisition.get(requisition.id) ?? [];
    const [yesNo, single, text] = questions;
    const answers: Record<string, Answer> = {};
    if (yesNo) answers[yesNo.id] = disqualified ? "NO" : "YES";
    if (single && spec.answers !== "partial") answers[single.id] = spec.applied % 2 === 0 ? "GT5" : "2TO5";
    if (text && spec.answers !== "partial" && spec.applied % 3 === 0) answers[text.id] = "Synthetic answer for the demo.";
    const score = scorePrescreen(questions, answers);

    // R8: the path to the status, one history row per step, a day apart.
    const path: ApplicationStatus[] = disqualified
      ? ["REJECTED"]
      : {
          APPLIED: ["APPLIED"],
          SCREENING: ["APPLIED", "SCREENING"],
          INTERVIEW: ["APPLIED", "SCREENING", "INTERVIEW"],
          OFFER: ["APPLIED", "SCREENING", "INTERVIEW", "OFFER"],
          HIRED: ["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED"],
          REJECTED: ["APPLIED", "SCREENING", "REJECTED"],
          WITHDRAWN: ["APPLIED", "WITHDRAWN"],
        }[spec.status as "APPLIED"] as ApplicationStatus[];
    const stepAt = (i: number) => {
      const last = path.length - 1;
      if (i === last && spec.decided !== undefined && i > 0) return this.ago(spec.decided);
      return new Date(Math.min(appliedAt.getTime() + i * 2 * DAY, this.deps.now.getTime() - (last - i) * 3_600_000));
    };
    const finalAt = stepAt(path.length - 1);
    const final = spec.status === "HIRED" || spec.status === "REJECTED" || spec.status === "WITHDRAWN";

    const [row] = await this.tx
      .insert(applications)
      .values({
        requisitionId: requisition.id,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        email: candidate.email,
        emailHash: computeEmailHash(candidate.email, this.deps.emailHashKey),
        phone: candidate.phone,
        source: requisition.postingType === "PRIVATE" ? "PRIVATE_LINK" : "CAREER_SITE",
        status: spec.status,
        reasonCode: spec.status === "REJECTED" ? (spec.reasonCode ?? "OTHER") : null,
        prescreenScore: score.total,
        isDisqualified: score.isDisqualified,
        consentAcceptedAt: appliedAt,
        consentVersion: this.consentVersion,
        appliedAt,
        dispositionedAt: final ? finalAt : null,
        hiredAt: spec.status === "HIRED" ? finalAt : null,
        exportedAt: spec.status === "HIRED" && spec.exported ? new Date(finalAt.getTime() + DAY) : null,
        createdAt: appliedAt,
        updatedAt: finalAt,
      })
      .returning();
    this.counts.applications += 1;

    const points = new Map(score.perQuestion.map((entry) => [entry.questionId, entry.points]));
    const answered = Object.entries(answers);
    if (answered.length > 0) {
      await this.tx.insert(prescreenAnswers).values(answered.map(([questionId, answer]) => ({ applicationId: row.id, questionId, answerJson: answer, points: points.get(questionId) ?? 0, createdAt: appliedAt })));
    }
    await this.tx.insert(applicationHistory).values(
      path.map((status, i) => ({
        applicationId: row.id,
        fromStatus: i === 0 ? null : path[i - 1],
        toStatus: status,
        // Creation is the system's (Quick Apply); later moves are the recruiter's.
        changedByUserId: i === 0 ? null : this.staff.recruiter,
        reasonCode: status === "REJECTED" ? row.reasonCode : null,
        isReopen: false,
        createdAt: stepAt(i),
      })),
    );

    const name = `${candidate.firstName} ${candidate.lastName}`;
    const cv = await samplePdf(`Curriculum vitae: ${name}`, [`Applied for: ${requisition.title}`, `Email: ${candidate.email}`, "Experience: fictional roles at fictional companies."]);
    await this.storeFile("APPLICATION", row.id, "CV", cv, `cv-${candidate.lastName.toLowerCase()}.pdf`, appliedAt);
    if (spec.coverLetter) {
      const letter = await samplePdf(`Cover letter: ${name}`, [`Dear hiring team of ${requisition.title},`, "this letter was generated for the demo."]);
      await this.storeFile("APPLICATION", row.id, "COVER_LETTER", letter, `cover-letter-${candidate.lastName.toLowerCase()}.pdf`, appliedAt);
    }
    return row;
  }

  // -- Interviews ---------------------------------------------------------------

  private async interview(
    application: typeof applications.$inferSelect,
    spec: { at: number; status: "SCHEDULED" | "COMPLETED"; participants: string[]; scorecards?: { by: string; rating: number; thumbsUp: boolean }[] },
  ) {
    // `at` is days ago; negative is the future. Whole hours at 10:00 UTC, so times look planned.
    const day = new Date(this.deps.now.getTime() - spec.at * DAY);
    day.setUTCHours(spec.at < 0 ? 9 : 10, 0, 0, 0);
    const created = new Date(Math.min(day.getTime(), this.deps.now.getTime()) - 3 * DAY);
    const [row] = await this.tx
      .insert(interviews)
      .values({
        applicationId: application.id,
        startsAtUtc: day,
        durationMinutes: 60,
        timezone: "Europe/Warsaw",
        locationOrLink: "Meeting room Synthetic 1",
        status: spec.status,
        icsUid: `${randomUUID()}@ats-demo.local`,
        icsSequence: 0,
        createdByUserId: this.staff.recruiter,
        createdAt: created,
        updatedAt: created,
      })
      .returning({ id: interviews.id });
    await this.tx.insert(interviewParticipants).values(spec.participants.map((userId) => ({ interviewId: row.id, userId, createdAt: created })));
    for (const scorecard of spec.scorecards ?? []) {
      const submitted = new Date(day.getTime() + 2 * 3_600_000);
      await this.tx.insert(interviewScorecards).values({
        interviewId: row.id,
        interviewerId: scorecard.by,
        overallRating: scorecard.rating,
        thumbsUp: scorecard.thumbsUp,
        comments: "Synthetic feedback: clear answers, good questions.",
        submittedAt: submitted,
        createdAt: submitted,
        updatedAt: submitted,
      });
    }
  }

  // -- Offers -------------------------------------------------------------------

  private async offer(application: typeof applications.$inferSelect, spec: { status: "DRAFT" | "PENDING" | "APPROVED"; created: number; sent?: number; accepted?: number }) {
    const { recruiter, hm } = this.staff;
    const created = this.ago(spec.created);
    const submitted = spec.status === "DRAFT" ? null : new Date(created.getTime() + 3_600_000);
    const approved = spec.status === "APPROVED" ? new Date(created.getTime() + DAY) : null;
    const [requisition] = await this.tx.select({ title: requisitions.title }).from(requisitions).where(eq(requisitions.id, application.requisitionId));
    const [row] = await this.tx
      .insert(offers)
      .values({
        applicationId: application.id,
        templateId: this.offerTemplateId,
        createdByUserId: recruiter,
        submittedByUserId: submitted ? recruiter : null,
        submittedAt: submitted,
        approverId: spec.status === "DRAFT" ? null : hm,
        jobTitle: requisition.title.replace(" (synthetic)", ""),
        salary: spec.status === "DRAFT" ? "78000.00" : "85000.00",
        currency: spec.status === "PENDING" ? "PLN" : "EUR",
        startDate: warsawRunDate(new Date(this.deps.now.getTime() + 45 * DAY)),
        approvalStatus: spec.status,
        candidateResponse: spec.accepted !== undefined ? "ACCEPTED" : "PENDING",
        sentAt: spec.sent !== undefined ? this.ago(spec.sent) : null,
        respondedAt: spec.accepted !== undefined ? this.ago(spec.accepted) : null,
        version: spec.status === "DRAFT" ? 1 : spec.accepted !== undefined ? 3 : 2,
        createdAt: created,
        updatedAt: created,
      })
      .returning();
    const events: (typeof approvalEvents.$inferInsert)[] = [];
    if (submitted) events.push({ subjectType: "OFFER", subjectId: row.id, event: "SUBMITTED", actorUserId: recruiter, toApproverId: hm, createdAt: submitted });
    if (approved) events.push({ subjectType: "OFFER", subjectId: row.id, event: "APPROVED", actorUserId: hm, createdAt: approved });
    if (events.length > 0) await this.tx.insert(approvalEvents).values(events);

    // P7 (Q2): a sent offer has its letter, rendered by the task 37 renderer directly (no job, no email).
    if (row.sentAt) {
      const { values, legalEntity } = await offerTokenValues(this.tx, row);
      // C3: the seeded letter says on its first page that it is synthetic, above the template's text.
      const body = `**${SYNTHETIC_PDF_NOTICE}**\n\n${await this.offerBody()}`;
      const bytes = await renderOfferLetter({ body, values, legalEntityLabel: legalEntity, letterDate: formatDate(warsawRunDate(row.sentAt)) });
      const [req] = await this.tx.select({ reqNumber: requisitions.reqNumber }).from(requisitions).where(eq(requisitions.id, application.requisitionId));
      await this.storeFile("OFFER", row.id, "OFFER_LETTER", bytes, `offer-letter-${req.reqNumber}.pdf`, row.sentAt);
    }
  }

  private offerTemplateBody?: string;
  private async offerBody(): Promise<string> {
    if (this.offerTemplateBody === undefined) {
      const [template] = await this.tx.select({ body: templates.body }).from(templates).where(eq(templates.id, this.offerTemplateId));
      this.offerTemplateBody = template.body ?? "";
    }
    return this.offerTemplateBody;
  }
}

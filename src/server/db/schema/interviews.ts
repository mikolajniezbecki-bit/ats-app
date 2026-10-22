// Interviews, participants and scorecards (ats-project-scope.md §7, tables
// 12–14).
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./administration";
import { applications } from "./applications";
import { enumCheck, id, timestamps } from "./columns";

export const INTERVIEW_STATUSES = ["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"] as const;

export const interviews = pgTable(
  "interviews",
  {
    id: id(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    startsAtUtc: timestamp("starts_at_utc", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    // IANA zone; validity is checked by the interview service (task 32).
    timezone: text("timezone").notNull(),
    locationOrLink: text("location_or_link").notNull(),
    status: text("status", { enum: INTERVIEW_STATUSES }).notNull().default("SCHEDULED"),
    icsUid: text("ics_uid").notNull(),
    icsSequence: integer("ics_sequence").notNull().default(0),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    unique("interviews_ics_uid_unique").on(t.icsUid),
    enumCheck("interviews_status_check", t.status, INTERVIEW_STATUSES),
    index("interviews_application_id_idx").on(t.applicationId),
    index("interviews_created_by_user_id_idx").on(t.createdByUserId),
  ],
);

export const interviewParticipants = pgTable(
  "interview_participants",
  {
    id: id(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // Also the interview_id foreign-key index.
    unique("interview_participants_interview_id_user_id_unique").on(t.interviewId, t.userId),
    index("interview_participants_user_id_idx").on(t.userId),
  ],
);

export const interviewScorecards = pgTable(
  "interview_scorecards",
  {
    id: id(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id),
    interviewerId: uuid("interviewer_id")
      .notNull()
      .references(() => users.id),
    overallRating: integer("overall_rating").notNull(),
    thumbsUp: boolean("thumbs_up").notNull(),
    comments: text("comments"),
    // NULL while the scorecard is a draft (I9).
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // Also the interview_id foreign-key index.
    unique("interview_scorecards_interview_id_interviewer_id_unique").on(t.interviewId, t.interviewerId),
    check("interview_scorecards_overall_rating_check", sql`${t.overallRating} BETWEEN 1 AND 5`),
    index("interview_scorecards_interviewer_id_idx").on(t.interviewerId),
  ],
);

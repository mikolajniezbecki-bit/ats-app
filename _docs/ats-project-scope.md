# Custom ATS & Career Portal: Functional Specification

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-10-19 |
| **Owner** | Mikolaj Niezbecki |
| **Status** | Approved for build |

**Purpose of this document:** defines **what** to build: scope, roles, modules, every business rule, and the data model. It is the primary input for the coding agent.

**Companion documents**
- `tech-stack.md` defines **how** it's built: architecture, technology, technical rules, testing, deployment.
- `tradeoffs.md` lists the **deliberate limitations** of this proof of concept and how each would be upgraded later.

**Rule IDs.** Every business rule has a stable ID (e.g. `R7`, `A2`). Each ID must have at least one automated test whose title starts with the ID and a colon (`tech-stack.md` §11, T1).

| Prefix | Area | Section |
|---|---|---|
| A | Approvals | §5.2 |
| L | Requisition lifecycle | §5.2 |
| S | Pre-screening scoring | §5.3 |
| F | Files, uploads & anti-spam | §5.3 |
| R | Pipeline transitions | §5.4 |
| I | Interviews & invites | §5.5 |
| E | Email | §5.7 |
| RT | Data retention | §5.8 |
| V | Data visibility | §4 |

---

## 1. Context

The company uses **SAP SuccessFactors Recruiting** for requisitions, candidate pipelines, interviews and offers. This project builds a standalone **Applicant Tracking System (ATS) with a public career portal** as a **proof of concept (PoC)** that covers the core recruiting workflow with a much simpler model. A later enterprise version will build on it (see `tradeoffs.md`).

### Project constraints
| # | Constraint | Consequence |
|---|---|---|
| C1 | Built and operated by the project owner alone, with no dependency on IT or other teams | Personal Azure subscription and its own Microsoft Entra tenant; no company domain, licences or approvals |
| C2 | Self-funded: free tiers or low monthly cost | Scale-to-zero hosting; capped logging; budget alert |
| C3 | **Demo/synthetic data only** | No real candidate or employee personal data is ever stored |
| C4 | **No real email delivery** | All outgoing email is built in full but captured for inspection, never delivered |

### Design principles
- **Simple, fixed processes:** four roles, single-step approvals, one fixed pipeline.
- **Every rule is explicit and testable.**
- **Upgrade-friendly:** external services sit behind interfaces; deferred features have reserved fields.

---

## 2. Scope

| Area | In scope | Out of scope |
|---|---|---|
| **Core** | Requisitions, pipeline, interviews, offers; public career portal with **External** and **Private** postings | Job-board multiposting; recruiting CRM, talent pools and campaigns; internal career site |
| **Master data** | Admin-managed Departments, Locations, Legal Entities, picklists and templates; CSV export of hires | Integration with SAP Employee Central or other HR systems; position/headcount management |
| **Access & workflow** | Four fixed roles; need-to-know visibility; single-step approvals with segregation of duties, reassignment and reminders | Field-level permissions; team-scoped recruiters; multi-step or rule-based approval routing; delegation |
| **Candidate experience** | Quick Apply without an account; PDF CV; pre-screening questions; privacy consent; CAPTCHA | Candidate accounts, job alerts, social login, CV parsing, DOCX uploads, languages other than English |
| **Communication** | Complete outgoing emails (shared sender, Reply-To = recruiter, `.ics` invites, PDF attachments), captured for inspection; email log | Real delivery; receiving replies; bounce handling; ad-hoc emails written in the tool |
| **Interviews & offers** | `.ics` invites with update/cancel; scorecards; offer letters as PDF from templates | Calendar availability, Teams links, self-scheduling, RSVP tracking, e-signature |
| **Privacy** | Single global retention period; anonymization of expired applications and related data; consent timestamp and version | Per-country retention; consent records; data-subject self-service; malware scanning |
| **Reporting** | KPI dashboard and CSV exports | Custom report builder |

---

## 3. Roles

| Role | Can do |
|---|---|
| **Admin** | Everything a Recruiter can, plus: settings, master data, templates, user management; reopen closed requisitions (L7); correct a Hired status (R4); reopen submitted scorecards (V8); view the Outbox and background-job pages |
| **Recruiter** | Create and manage requisitions, publish postings, screen and move candidates, schedule interviews, create offers, export hires, reassign pending approvals |
| **Hiring Manager** | Create requisitions; approve requisitions and offers assigned to them (never items they submitted, A2); review candidates and feedback on their requisitions |
| **Interviewer** | View assigned applications and submit scorecards for their interviews |

Each user has exactly one role. Users are created by an Admin before they can sign in (invite-only, `tech-stack.md` AU2).

---

## 4. Data Visibility

| Rule | Behaviour |
|---|---|
| V1 Admin | Full access. |
| V2 Recruiter | All requisitions, applications, scorecards and offers. |
| V3 Hiring Manager scope | Requisitions where they are `hiring_manager_id` or `approver_id`; offers where they are the approver. |
| V4 Hiring Manager data | For requisitions in scope: applications, CVs, pre-screening answers and score, submitted scorecards, offers including salary. |
| V5 Interviewer scope | Applications in an **open** status that have at least one interview where `interview_participants.user_id = user.id AND removed_at IS NULL AND interviews.status <> 'CANCELLED'`. |
| V6 Interviewer data | CV, cover letter, name, email, phone, interview details and their own scorecards. **Not:** offers, salary, pre-screening answers or score, status comments, other applications by the same person. |
| V7 Hidden scorecards | An interviewer sees other interviewers' submitted scorecards on an application only when **at least one** of their own scorecards on that application has `submitted_at IS NOT NULL` **and none** of their scorecards on it is reopened-but-not-resubmitted (`reopened_at IS NOT NULL AND submitted_at IS NULL`). Enforced in the API. |
| V8 Access end & locking | Interviewer access ends as soon as V5 no longer holds (final status, removal from the interview, or cancellation). A submitted scorecard is read-only. An Admin may reopen it: `reopened_at = now()`, `submitted_at = NULL` until resubmitted. |
| V9 Enforcement | All checks go through one central policy module (`can(user, action, resource)`) plus reusable row-level query filters. The API never returns data the caller may not see; hiding data only in the UI is not sufficient. |
| V10 Exports | CSV exports are available to Recruiter and Admin only. |
| V11 File links | Signed file links are issued only after the same policy check and expire after 5 minutes. |

---

## 5. Functional Modules

### 5.1 Administration & Master Data
- **Master data:** CRUD for Departments, Locations, Legal Entities and custom picklists. Records are deactivated, never hard-deleted, once referenced.
- **Templates** (English only):
  - *Requisition templates* define custom fields (contract in §7, `templates.schema_json`).
  - *Email templates* have a subject, body and optional `trigger_status` (E8).
  - *Offer templates* hold the letter text with tokens.
  - Templates are unique by (type, name) and loaded through one resolver, `resolveTemplate(type, name)`.
- **Tokens:** `[[CANDIDATE_FULL_NAME]]`, `[[JOB_TITLE]]`, `[[REQ_NUMBER]]`, `[[HIRING_MGR_FULL_NAME]]`, `[[RECRUITER_FULL_NAME]]`, `[[RECRUITER_EMAIL]]`, `[[INTERVIEW_DATETIME]]`, `[[INTERVIEW_LOCATION]]`, `[[OFFER_SALARY]]`, `[[OFFER_CURRENCY]]`, `[[START_DATE]]`, `[[LEGAL_ENTITY]]`, `[[LOGO]]`. An unknown token is an error, never output as raw text.
- **Settings** (Admin-editable; defaults in brackets):

| Setting | Default |
|---|---|
| `RETENTION_DAYS` | 180 |
| `REJECTION_EMAIL_DELAY_HOURS` | 24 |
| `APPROVAL_REMINDER_DAYS` | 3 |
| `MAX_UPLOAD_MB` | 5 |
| `SENDER_EMAIL` | `careers@ats-demo.local` |
| `FALLBACK_REPLY_TO_EMAIL` | `recruiting@ats-demo.local` |
| `PRIVACY_STATEMENT_VERSION` + text | `1.0` + demo statement |

- **User management:** create a user (email, name, one role), change role, deactivate. Deactivation is blocked while the user is the approver of a pending item (A5) and ends all their sessions.
- **Admin tools:** Outbox (`/admin/outbox`), background jobs and daily-task runs.

### 5.2 Job Requisitions

**Creation:** from a template, blank, or by duplicating an existing requisition. `req_number` is assigned on creation (`REQ-00001`, `REQ-00002`, …).

**States**

```
DRAFT ──submit──► PENDING_APPROVAL ──approve──► APPROVED ⇄ ON_HOLD
  ▲                    │                           │           │
  └──reject/withdraw───┘                           └──close────┴──► CLOSED ──reopen (Admin)──► APPROVED
```

`PENDING_APPROVAL` with `approved_at IS NOT NULL` is a **re-approval** of a live requisition (L2).

**Approval rules** (apply to requisitions and offers unless stated otherwise)

| Rule | Behaviour |
|---|---|
| A1 Approver selection | On each submission, the submitter picks one active user with role `HIRING_MANAGER` or `ADMIN` as approver. The system records `submitted_by_user_id` and `submitted_at`. |
| A2 Segregation of duties | `approver_id` must differ from `submitted_by_user_id`. Enforced in the backend on submission and on reassignment; no role can bypass it. |
| A3 Decision | The approver approves or rejects; a comment is required to reject. **Requisition, first approval** (`approved_at IS NULL`): approve → `APPROVED`, `approved_at = now()`, `is_published = true`; reject → `DRAFT`. **Requisition re-approval** (`approved_at IS NOT NULL`): approve → `APPROVED`, clear `previous_l2_values_json`, keep the original `approved_at`; reject → restore the L2 fields from `previous_l2_values_json`, clear it, `APPROVED`. **Offer:** approve → `APPROVED` (P7 renders the letter); reject → `REJECTED`, editable and resubmittable as `PENDING`. |
| A4 Reassignment | Recruiters and Admins can reassign a pending approval to another eligible approver; a reason is required and A2 applies. |
| A5 Deactivation guard | A user who is the approver of any pending item can't be deactivated until those items are reassigned. |
| A6 Reminders | Daily: for each pending item, send a reminder when `now − last_event_at ≥ APPROVAL_REMINDER_DAYS`, where `last_event_at` is the latest `SUBMITTED`, `REASSIGNED` or `REMINDED` event for that item. To: approver; Cc: submitter. |
| A7 Audit | Every submission, approval, rejection, withdrawal, reassignment and reminder is written to `approval_events`. |
| A8 Offer re-approval | Changing the salary, currency or start date of an approved offer returns it to `PENDING` with a new approval required; a new letter is rendered when it's approved. |
| A9 Withdraw submission | The submitter, a Recruiter or an Admin can withdraw a pending item. Requisition first approval → `DRAFT`. Requisition re-approval → same effect as a rejection (L2 values restored). Offer → `DRAFT`. |

**Lifecycle rules**

| Rule | Behaviour |
|---|---|
| L1 Free edits | While `APPROVED`, `ON_HOLD` or in re-approval, these fields can change without approval: title, description, location, recruiter, posting type, custom fields; pre-screening questions can be added (L3). |
| L2 Re-approval triggers | Only from `APPROVED`: increasing `openings_count`, or changing `department_id`, `hiring_manager_id` or `legal_entity_id`, saves the current values of those four fields in `previous_l2_values_json`, applies the change, sets `PENDING_APPROVAL` and starts a new approval (A1–A2). The posting stays published and the pipeline stays workable. While in re-approval, the four L2 fields are locked. Decreasing `openings_count` needs no approval but can't go below the number already hired. |
| L3 Pre-screening edits | Once any application has answered a question, the question can't be deleted and its type, options, weight, scoring answer and disqualifying answer can't change; it can be deactivated. New questions can be added at any time. |
| L4 On Hold | `APPROVED → ON_HOLD`: `is_published = false`, `on_hold_since = now()`. Applications can still be moved between open stages and rejected. |
| L5 Resume | `ON_HOLD → APPROVED`: add `(now − on_hold_since)` in days (2 decimals) to `hold_duration_days`, clear `on_hold_since`, `is_published = true`. |
| L6 Close | `close_reason` is `FILLED` (automatic, R6) or `CANCELLED` (manual from `APPROVED` or `ON_HOLD`, comment required). On close: if `ON_HOLD`, first add the hold time as in L5; all open applications become `REJECTED` (`reason_code` `REQ_FILLED` / `REQ_CANCELLED`) with the rejection email per E8; non-final offers become `WITHDRAWN`; `is_published = false`; `closed_at = now()`. |
| L7 Reopen | Admin only, comment required: `CLOSED → APPROVED`; `closed_at` and `close_reason` cleared (the earlier close stays in history); `is_published = true`. Auto-rejected applications are not restored automatically (use R3). |
| L8 Blocked actions | While a requisition is `ON_HOLD` or `PENDING_APPROVAL`, it is not possible to create, submit or approve offers, or to move an application to `HIRED`. A requisition in first-approval `PENDING_APPROVAL` can't be edited at all (use A9 to withdraw it first). |
| L9 Publishing | `is_published` becomes `true` on first approval (A3), resume (L5) and reopen (L7), and `false` on hold (L4) and close (L6). While `APPROVED`, a Recruiter can unpublish or republish manually. When `posting_type = 'PRIVATE'` and `private_slug` is empty, a slug of 32 random hex characters is generated on save. |
| L10 KPIs | **Time to Fill** (only `close_reason = FILLED`) = `closed_at − approved_at − hold_duration_days`. **Age of Requisition** (open requisitions) = `now − approved_at − hold_duration_days − current hold`, where current hold = `now − on_hold_since` while `ON_HOLD`. |
| L11 Audit | Every state change and every L2 field change is written to `requisition_history`. |

**Postings:** `EXTERNAL` postings are listed on the public job board. `PRIVATE` postings are reachable only through `/jobs/p/{private_slug}`, carry `noindex`, and are excluded from listings, search and the sitemap. Private postings are how internal vacancies are shared with employees.

### 5.3 Career Portal & Candidate Intake

- **Job board:** mobile-friendly, server-rendered list with keyword search and filters by Location and Department. Shows requisitions where `posting_type = 'EXTERNAL' AND is_published = true`.
- **Accepting applications:** any requisition with `is_published = true` (including Private postings via their link and requisitions in re-approval). Otherwise the job page shows "This position is no longer accepting applications."
- **Quick Apply** (single page, no account): first name, last name, email, phone, CV (required), cover letter (optional), pre-screening answers, privacy consent checkbox showing the current statement (stores `consent_accepted_at` and `consent_version`).
- **Duplicate detection:** `email_hash` = HMAC-SHA-256 of `email.trim().toLowerCase()` with the secret `EMAIL_HASH_KEY`, as 64 lowercase hex characters. Applications are grouped by `email_hash` in the recruiter view; they are never merged.
- **On submit:** score the answers (S1–S4). If disqualified, create the application as `REJECTED` with `reason_code = DISQUALIFIED` and queue the rejection email with the delay (E8). Otherwise create it as `APPLIED` and queue the acknowledgement email.

**Pre-screening scoring**

| Rule | Behaviour |
|---|---|
| S1 Text | Informational only: `weight = 0`, no scoring or disqualifying answer. |
| S2 Yes/No and single choice | An answer equal to `scoring_answer` earns `weight` points, otherwise 0. An answer equal to `disqualifying_answer` sets `is_disqualified = true`. |
| S3 Multiple choice | `scoring_answer` is a set of option codes; an exactly matching selection earns `weight`, otherwise 0. `disqualifying_answer` is a set of forbidden codes; selecting any of them sets `is_disqualified = true`. |
| S4 Totals | Per-question points are stored in `prescreen_answers.points`; `applications.prescreen_score` is their sum. Only active questions are shown and scored. |

**Files & anti-spam**

| Rule | Behaviour |
|---|---|
| F1 Formats | CV, cover letter and interview notes: **PDF only**. |
| F2 Size | Max `MAX_UPLOAD_MB` per file, checked in the browser and on the server. |
| F3 Content check | The server verifies the `%PDF-` file signature (not just the extension) and rejects encrypted or password-protected PDFs. |
| F4 Storage | Files are stored in a private container under random keys and are reachable only through signed links (V11). |
| F5 Viewing | PDFs open inline in the browser with `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` and a restrictive Content Security Policy. |
| F6 Anti-spam | The apply endpoint is rate-limited to 5 submissions per IP per hour, protected by Cloudflare Turnstile, and includes a hidden honeypot field. |
| F7 Duplicate submission | Same `email_hash` + same requisition within 24 hours → rejected with "You have already applied for this position." |
| F8 Deletion | Files are deleted from storage by the retention purge (RT4). |

### 5.4 Candidate Pipeline

**Statuses:** open = `APPLIED`, `SCREENING`, `INTERVIEW`, `OFFER`; final = `HIRED`, `REJECTED`, `WITHDRAWN`.

| Rule | Behaviour |
|---|---|
| R1 Open ↔ open | Any move between open statuses, forward or backward, including skipping stages. |
| R2 Open → final | Any open status can move to `REJECTED` or `WITHDRAWN`. `HIRED` is allowed only from `OFFER` when the application has an offer with `candidate_response = ACCEPTED`. |
| R3 Reopen | `REJECTED` or `WITHDRAWN` can return to any open status while the requisition is `APPROVED` or in re-approval. Recruiter or Admin; comment required. |
| R4 Hired correction | `HIRED` can't be changed in normal use. An Admin can correct it to `OFFER`, `REJECTED` or `WITHDRAWN` (comment required): `hired_at` is cleared. A `CLOSED` requisition is not reopened automatically (use L7). |
| R5 Openings guard | Moving to `HIRED` is **blocked** when the number of hired applications already equals `openings_count`, and while the requisition is `ON_HOLD` or `PENDING_APPROVAL` (L8). |
| R6 Auto-close | When the number of hired applications reaches `openings_count`, the requisition closes with `close_reason = FILLED` (L6). |
| R7 Pending email cancellation | Any status change cancels that application's queued, unsent emails (including a delayed rejection) in the same transaction, setting them to `CANCELLED`. |
| R8 History | Every change writes `application_history` (from, to, user, comment, reason code, `is_reopen`). |
| R9 Concurrency | Updates use optimistic locking; a stale update fails with "This record was changed by someone else. Reload and try again." |
| R10 Offer precondition | An offer can be created only when the application status is `OFFER`. |
| R11 Disposition date | `dispositioned_at` is set to `now()` whenever an application enters `REJECTED`, `WITHDRAWN` or `HIRED`, and cleared whenever it returns to an open status. `hired_at` is set on entering `HIRED`. |
| R12 Interview cancellation | When an application reaches a final status, its future `SCHEDULED` interviews are cancelled (I4). |

**Recruiter workbench**
- Application list per requisition with status, score and grouping by `email_hash`.
- Inline PDF viewer; a timeline per application showing status history, emails, interviews, scorecards and offers.
- Optional comment on every status change.
- **Bulk actions:** move status or send a templated email to selected applications. Each application is validated individually against R1–R12; the result is reported per application.

### 5.5 Interviews & Scorecards

| Rule | Behaviour |
|---|---|
| I1 Data | An interview stores the start time (UTC), duration, IANA time zone (default: the recruiter's browser zone), location or meeting link, status (`SCHEDULED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`), a stable calendar UID and a sequence number starting at 0. Interviewers are stored as participants. |
| I2 Invite | On creation, a **separate** email with an `.ics` invite (`METHOD:REQUEST`, sent as an attachment and as `text/calendar`) goes to the candidate and to each interviewer. Each invite lists only its recipient as attendee. The organizer is `SENDER_EMAIL`. |
| I3 Reschedule | A change of time, duration, location or link increments the sequence and resends `REQUEST` with the same UID to all current recipients. |
| I4 Cancel | Cancelling sends `METHOD:CANCEL` (same UID, sequence + 1) to all current recipients. |
| I5 Participant change | An added interviewer receives the current invite; a removed interviewer receives a cancellation. |
| I6 Time display | Staff see times in their browser time zone; emails show the time in the interview's time zone with its name; `.ics` files use UTC times. |
| I7 Outcome | A `SCHEDULED` interview whose end time has passed shows "Awaiting outcome"; the recruiter marks it `COMPLETED` or `NO_SHOW`. |
| I8 No automatic status | Scheduling an interview doesn't change the application status. |
| I9 Scorecard | One scorecard per interviewer per interview: thumbs up/down, overall rating 1–5, comments, optional PDF notes. It can be submitted only for a `SCHEDULED` or `COMPLETED` interview whose start time has passed. Locking and reopening follow V8. |
| I10 Summary | Recruiters and Hiring Managers see, per application, the average rating and the thumbs-up/down count of submitted scorecards, plus each scorecard (subject to V-rules). |

### 5.6 Offers & Hand-off

- **Precondition:** R10. **Blocked states:** L8.
- **Offer form:** job title, salary, currency (ISO 4217), start date, offer template.
- **Statuses:** `approval_status` = `DRAFT` → `PENDING` → `APPROVED` / `REJECTED`, or `WITHDRAWN`; `candidate_response` = `PENDING` / `ACCEPTED` / `DECLINED`.
- **One active offer per application:** a new offer can be created only when every earlier offer is `REJECTED`, `WITHDRAWN` or declined. Earlier offers remain visible in history.
- **Approval:** A1–A4, A8, A9.
- **Letter:** after approval the letter is rendered as PDF from the offer template, stored, and emailed to the candidate with the PDF attached.
- **Response:** the recruiter records `ACCEPTED` or `DECLINED`. Declined: the application stays in `OFFER` (new offer, back to `INTERVIEW`, or reject). Accepted: the application can move to `HIRED` (R2, R5).
- **Hire export:** CSV of hired applications (name, email, phone, job title, department, location, legal entity, start date, salary, currency, hired date). Exporting sets `exported_at` on each row and is recorded in the audit log. Recruiter and Admin only.

### 5.7 Email

| Rule | Behaviour |
|---|---|
| E1 Sender | Every email is sent from `SENDER_EMAIL` through one email service. |
| E2 Reply-To | The **current** recruiter of the requisition at the moment of sending; if none, `FALLBACK_REPLY_TO_EMAIL`. |
| E3 Footer | Candidate emails include `[[RECRUITER_EMAIL]]` and the line "Reply to this email to reach your recruiter." |
| E4 Email log | Every email is recorded in `email_log` with its full content, `.ics`, attachment references, status and timestamps, and appears on the application timeline. |
| E5 Retries | Sending is retried with backoff; after the final failure the status is `FAILED` and the application shows a warning. |
| E6 Capture | Emails are captured rather than delivered (C4): status `CAPTURED`, viewable in the Outbox (Admin only). |
| E7 Internal notifications | Approval requests, reminders and interview assignments use the same service and log. |
| E8 Stage emails | A status change sends an email **only** if an active email template exists with `trigger_status` equal to the new status. Shipped templates: `APPLIED` (acknowledgement, immediate) and `REJECTED` (sent after `REJECTION_EMAIL_DELAY_HOURS`). |
| E9 Flow emails | Interview emails come only from I2–I5 and offer emails only from the offer flow (§5.6). Moving an application to `INTERVIEW` or `OFFER` sends nothing by itself. |

### 5.8 Privacy & Data Retention

| Rule | Behaviour |
|---|---|
| RT1 Clock | Retention is counted from `dispositioned_at` (R11). |
| RT2 Selection | Daily, select applications where `anonymized_at IS NULL AND status IN ('REJECTED','WITHDRAWN','HIRED') AND (status <> 'HIRED' OR exported_at IS NOT NULL) AND dispositioned_at + RETENTION_DAYS < now()`. Open applications are never selected. |
| RT3 Application | Set `first_name`, `last_name`, `email`, `email_hash` and `phone` to NULL and `anonymized_at = now()`. Keep status, reason code, timestamps, `prescreen_score` and `is_disqualified`. |
| RT4 Related data | Delete the application's `prescreen_answers`; clear `application_history.comment` and `interview_scorecards.comments`; delete all linked files (CV, cover letter, interview notes, offer letters) from storage and set `files.deleted_at`; clear `recipient`, `subject`, `body_rendered` and `ics_content` in its `email_log` rows. |
| RT5 Execution | Processed in batches, one transaction per application; safe to rerun. |

### 5.9 Reporting
- **KPI cards:** open requisitions; active applications per status; average Time to Fill; average Time to Hire (`hired_at − applied_at`); Age of Requisition per open requisition (L10).
- **CSV exports:** requisition list and pipeline data (V10).

---

## 6. Background Jobs

| Job | Trigger | Purpose |
|---|---|---|
| `email.send` | Queued on demand; optionally delayed | Build and send/capture an email (E1–E9). Delayed rejections use the same job with a start time (R7 cancels them). |
| `offer.render-pdf` | Queued on offer approval | Render the letter, store it, queue the offer email |
| `approvals.remind` | Daily, after 08:00 Europe/Warsaw | A6 |
| `retention.purge` | Daily, after 02:00 Europe/Warsaw | RT1–RT5 |

Timing is best-effort: the application sleeps when idle and is woken hourly, so scheduled work may run up to about one hour after its due time (`tech-stack.md` §6).

---

## 7. Data Model

**Conventions:** PostgreSQL 17; UUID primary keys; `created_at` and `updated_at` (`timestamptz`) on every table; all times in UTC; enumerations stored as text with check constraints; every foreign key indexed.

| # | Table | Columns and constraints |
|---|---|---|
| 1 | **users** | `id`, `email` (unique, lower-case), `name`, `email_verified` (boolean, set `true` when an Admin creates the user), `image` (nullable), `role` (`ADMIN`, `RECRUITER`, `HIRING_MANAGER`, `INTERVIEWER`), `is_active` (default true). Shared with the authentication library (`tech-stack.md` §4). |
| 2 | **master_data** | `id`, `type` (`DEPARTMENT`, `LOCATION`, `LEGAL_ENTITY`, `PICKLIST`), `picklist_key` (nullable; required for `PICKLIST`), `code`, `label`, `is_active`. `UNIQUE NULLS NOT DISTINCT (type, picklist_key, code)`. |
| 3 | **templates** | `id`, `type` (`REQUISITION`, `EMAIL`, `OFFER`), `name`, `trigger_status` (nullable; `EMAIL` only), `subject` (nullable; `EMAIL`), `body` (nullable; `EMAIL`, `OFFER`), `schema_json` (jsonb, nullable; `REQUISITION`), `is_active`. `UNIQUE (type, name)`. Partial unique index on `(trigger_status) WHERE type = 'EMAIL' AND is_active AND trigger_status IS NOT NULL`. `schema_json` = `Array<{ key, label, type: 'TEXT'│'NUMBER'│'BOOLEAN'│'PICKLIST', picklist_key?, required }>`. |
| 4 | **settings** | `key` (PK), `value`, `updated_by`, `updated_at`. |
| 5 | **requisitions** | `id`, `req_number` (unique; `'REQ-' ‖ lpad(nextval('req_number_seq')::text, 5, '0')`), `title`, `template_id`, `department_id`, `location_id`, `legal_entity_id`, `hiring_manager_id`, `recruiter_id`, `created_by_user_id`, `submitted_by_user_id` (nullable), `submitted_at` (nullable), `approver_id` (nullable), `state` (`DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `ON_HOLD`, `CLOSED`), `close_reason` (`FILLED`, `CANCELLED`, nullable), `openings_count` (≥ 1), `description_html`, `custom_fields_json` (jsonb; `Record<string, string│number│boolean│null>`, validated against the template), `posting_type` (`EXTERNAL`, `PRIVATE`), `private_slug` (unique, nullable), `is_published` (default false), `approved_at` (nullable), `previous_l2_values_json` (jsonb, nullable), `on_hold_since` (nullable), `hold_duration_days` (`numeric(10,2)`, default 0), `closed_at` (nullable), `version`. |
| 6 | **requisition_history** | `id`, `requisition_id`, `event` (`STATE_CHANGE`, `FIELD_CHANGE`, `REOPEN`), `field`, `old_value`, `new_value`, `user_id`, `comment`, `created_at`. |
| 7 | **prescreen_questions** | `id`, `requisition_id`, `question_text`, `question_type` (`YES_NO`, `SINGLE`, `MULTI`, `TEXT`), `options_json` (array of `{ code, label }`), `weight` (int ≥ 0), `scoring_answer` (jsonb, nullable), `disqualifying_answer` (jsonb, nullable), `is_active`, `sort_order`. |
| 8 | **applications** | `id`, `requisition_id`, `candidate_id` (nullable, reserved), `first_name`, `last_name`, `email`, `email_hash`, `phone` (these five nullable), `status`, `reason_code` (nullable: `DISQUALIFIED`, `REQ_FILLED`, `REQ_CANCELLED`, `OTHER`), `source` (`CAREER_SITE`, `PRIVATE_LINK`), `prescreen_score`, `is_disqualified`, `consent_accepted_at`, `consent_version`, `applied_at`, `dispositioned_at`, `hired_at`, `exported_at`, `anonymized_at`, `version`. Check: `anonymized_at IS NOT NULL OR (first_name, last_name, email, email_hash, phone all NOT NULL)`. Index `(requisition_id, email_hash, applied_at)`. |
| 9 | **prescreen_answers** | `id`, `application_id`, `question_id`, `answer_json`, `points`. |
| 10 | **application_history** | `id`, `application_id`, `from_status`, `to_status`, `changed_by_user_id` (nullable = system), `comment` (nullable), `reason_code`, `is_reopen`, `created_at`. |
| 11 | **files** | `id`, `owner_type` (`APPLICATION`, `SCORECARD`, `OFFER`), `owner_id`, `kind` (`CV`, `COVER_LETTER`, `INTERVIEW_NOTES`, `OFFER_LETTER`), `mime`, `size_bytes`, `storage_key`, `status` (`CLEAN`; reserved `PENDING_SCAN`, `QUARANTINED`), `deleted_at`. |
| 12 | **interviews** | `id`, `application_id`, `starts_at_utc`, `duration_minutes`, `timezone`, `location_or_link`, `status`, `ics_uid` (unique), `ics_sequence`, `created_by_user_id`. |
| 13 | **interview_participants** | `id`, `interview_id`, `user_id`, `removed_at` (nullable). `UNIQUE (interview_id, user_id)`. |
| 14 | **interview_scorecards** | `id`, `interview_id`, `interviewer_id`, `overall_rating` (1–5), `thumbs_up`, `comments` (nullable), `submitted_at` (nullable), `reopened_at` (nullable). `UNIQUE (interview_id, interviewer_id)`. |
| 15 | **offers** | `id`, `application_id`, `template_id`, `created_by_user_id`, `submitted_by_user_id` (nullable), `submitted_at` (nullable), `approver_id` (nullable; check: required unless `approval_status = 'DRAFT'`), `job_title`, `salary` (`numeric(12,2)`), `currency` (ISO 4217), `start_date`, `approval_status`, `candidate_response`, `sent_at`, `responded_at`. |
| 16 | **approval_events** | `id`, `subject_type` (`REQUISITION`, `OFFER`), `subject_id`, `event` (`SUBMITTED`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `REASSIGNED`, `REMINDED`), `actor_user_id` (nullable = system), `from_approver_id`, `to_approver_id`, `comment`, `created_at`. Index `(subject_type, subject_id, created_at)`. |
| 17 | **email_log** | `id`, `application_id` (nullable), `template_id` (nullable), `job_id` (nullable), `recipient` (nullable after purge), `reply_to`, `subject` (nullable), `body_rendered` (nullable), `ics_content` (nullable), `attachment_file_ids` (uuid[], default `{}`), `status` (`QUEUED`, `SENT`, `CAPTURED`, `FAILED`, `CANCELLED`), `scheduled_for`, `sent_at`, `provider_message_id`, `ics_uid`, `ics_sequence`, `direction` (`OUTBOUND`), `error`. |
| 18 | **audit_log** | `id`, `actor_user_id`, `action` (e.g. `EXPORT_HIRES`, `USER_DEACTIVATED`, `SETTING_CHANGED`), `subject_type`, `subject_id`, `details_json`, `created_at`. |
| 19 | **job_runs** | `job_name`, `run_date`, `started_at`, `finished_at`, `status`. `UNIQUE (job_name, run_date)`. |
| — | **Authentication tables** | `session`, `account`, `verification`: owned by the authentication library (`tech-stack.md` §4). |
| — | **Job queue tables** | Owned by pg-boss in its own schema (`tech-stack.md` §5). |

---

## 8. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Security | HTTPS only; private file storage with short-lived signed links; secrets never in code; restrictive Content Security Policy; all authorization server-side (V9). |
| Privacy | Logs contain identifiers only, never personal data. |
| Accessibility | Keyboard-navigable forms with labels; WCAG 2.1 AA colour contrast on the career portal. |
| Performance | Job board and job pages server-rendered; typical page response under 1 s once the app is awake. |
| Availability | Demo-grade: the app sleeps when idle; the first request after idle can take several seconds. |
| Browsers | Current Chrome, Edge, Firefox and Safari; mobile-friendly career portal. |
| Language & formats | English UI; dates displayed in the user's locale; currency as ISO code + amount. |
| Testability | Every rule ID has at least one automated test. |

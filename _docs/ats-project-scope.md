# Custom ATS & Career Portal: Functional Specification

| | |
|---|---|
| **Version** | 1.4 |
| **Date** | 2026-10-20 |
| **Owner** | Mikolaj Niezbecki |
| **Status** | Approved for build |
| **Changes in 1.4** | Tasks 16–21 grooming: template rules, token scopes, escaping and formats, system emails as fixed texts (§5.1, E8); seeded settings count as default; inactive values kept only if already stored; requisition creation, duplication, template and Hiring Manager edit rules (§5.2); pre-screening question rules and scoring edge cases (§5.3, S2–S4); Reply-To/footer when the recruiter is inactive (E2, E3); `FAILED` after the last retry (E5); purge cancels queued emails (RT4); 404 for out-of-scope reads (V9); `email_log.audience` and `requisition_id`; field limits (§7) |
| **Changes in 1.3** | Tasks 10–15 grooming: settings allowed values, `PRIVACY_STATEMENT_TEXT`, a text change needs a new version, settings audit (§5.1); master data codes immutable, code formats, "referenced" defined (§5.1); user management adds name edit, reactivation, lock-out guards, audit actions, multi-role picker (§5.1); A5 also blocks a pending approver's role change; F2 MiB, F3 empty/permissions-only/unparsable PDFs rejected; F5 CSP on all app pages; auth tables follow §7 conventions |
| **Changes in 1.2** | Tasks 4–6 grooming: §7 conventions (keys, nullability, no cascades), `job_runs` id and statuses, `master_data.picklist_key` check, `files.original_name` (cleared by RT4), `offers` approver check allows `WITHDRAWN`, currency format check |
| **Changes in 1.1** | Decisions from `open-questions.md` (Q1–Q27) applied |

**Purpose of this document:** defines **what** to build: scope, roles, modules, every business rule, and the data model. It is the primary input for the coding agent.

**Companion documents**
- `tech-stack.md` defines **how** it's built: architecture, technology, technical rules, testing, deployment.
- `tradeoffs.md` lists the **deliberate limitations** of this proof of concept and how each would be upgraded later.

**Rule IDs.** Every business rule has a stable ID (e.g. `R7`, `A2`). Every ID listed as **required** in `tech-stack.md` §11, T1, must have at least one automated test whose title starts with the ID and a colon. T1 is the single source for which IDs are required and which are exempt.

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
| **Recruiter** | Create and manage requisitions, publish postings, screen and move candidates, schedule interviews, create and discard offers, export hires, reassign pending approvals |
| **Hiring Manager** | Create requisitions; approve requisitions and offers assigned to them (never items they submitted, A2); review candidates, status history and feedback on requisitions in their scope (V3). **Read-only** on applications: only Recruiters and Admins move statuses, schedule interviews and manage offers |
| **Interviewer** | View assigned applications and submit scorecards for their interviews |

Each user has exactly one role. Users are created by an Admin before they can sign in (invite-only, `tech-stack.md` AU2).

---

## 4. Data Visibility

| Rule | Behaviour |
|---|---|
| V1 Admin | Full access. |
| V2 Recruiter | All requisitions, applications, scorecards and offers. |
| V3 Hiring Manager scope | (a) Requisitions where they are `hiring_manager_id`, `approver_id` or `created_by_user_id` (full V4 data). (b) As the **current** `approver_id` of an offer: that offer, **that single application** (V4 data) and the requisition header (title, number, department, location, openings); not other applications on the requisition unless (a) applies. Approver access follows the current approver only: after reassignment (A4) the previous approver loses it unless another V3 condition still applies. |
| V4 Hiring Manager data | For requisitions in scope: applications, CVs, pre-screening answers and score, status history and comments (`application_history`), submitted scorecards, offers including salary. Read-only (§3). |
| V5 Interviewer scope | Applications in an **open** status that have at least one interview where `interview_participants.user_id = user.id AND removed_at IS NULL AND interviews.status <> 'CANCELLED'`. |
| V6 Interviewer data | CV, cover letter, name, email, phone, interview details and their own scorecards. **Not:** offers, salary, pre-screening answers or score, status comments, other applications by the same person. |
| V7 Hidden scorecards | An interviewer sees other interviewers' submitted scorecards on an application only when **at least one** of their own scorecards on that application has `submitted_at IS NOT NULL` **and none** of their scorecards on it is reopened-but-not-resubmitted (`reopened_at IS NOT NULL AND submitted_at IS NULL`). Enforced in the API. |
| V8 Access end & locking | Interviewer access ends as soon as V5 no longer holds (final status, removal from the interview, or cancellation). This includes their unsubmitted scorecards: once the application is `HIRED`, `REJECTED` or `WITHDRAWN`, a scorecard not yet submitted can no longer be submitted (`tradeoffs.md` TO-20). A submitted scorecard is read-only. An Admin may reopen it: `reopened_at = now()`, `submitted_at = NULL` until resubmitted. |
| V9 Enforcement | All checks go through one central policy module (`can(user, action, resource)`) plus reusable row-level query filters. The API never returns data the caller may not see; hiding data only in the UI is not sufficient. A record outside the caller's scope returns 404, not 403. |
| V10 Exports | CSV exports are available to Recruiter and Admin only. |
| V11 File links | Signed file links are issued only after the same policy check and expire after 5 minutes. |

---

## 5. Functional Modules

### 5.1 Administration & Master Data
- **Master data:** CRUD for Departments, Locations, Legal Entities and custom picklists. Records are deactivated, never hard-deleted, once referenced; deactivated records can be reactivated. A Department, Location or Legal Entity is referenced when a requisition points to it; a picklist value is referenced when a custom field bound to its `picklist_key` uses its code. `code`, `type` and `picklist_key` can't change after creation; `code` matches `^[A-Z0-9_-]{1,50}$` and `picklist_key` matches `^[a-z0-9_]{1,50}$`. Pickers offer active records only; on an existing record, an inactive value is accepted only if it is already stored there.
- **Templates** (English only):
  - *Requisition templates* define custom fields (contract in §7, `templates.schema_json`).
  - *Email templates* have a subject, body and optional `trigger_status` (E8). Active templates without `trigger_status` are the ones offered for bulk email (§5.4).
  - *Offer templates* hold the letter text with tokens.
  - Email and offer bodies are plain text with the markup subset of `tech-stack.md` P3, never raw HTML.
  - **System emails** (approval request and reminder, interview invite/update/cancel, offer email) are fixed texts built in code from `messages/en.json`, not editable `EMAIL` templates, so they never appear in bulk email (E7, E9).
  - A template's type and name can't change after creation. A template is deleted only when nothing references it; otherwise it is deactivated. Once a requisition uses a requisition template, its field list can only grow (no removal or type change); field keys match `^[a-z][a-z0-9_]{0,49}$` and a `PICKLIST` field's `picklist_key` must exist in master data.
  - The resolver returns active templates only; stage emails are looked up by trigger status (E8).
  - Templates are unique by (type, name) and loaded through one resolver, `resolveTemplate(type, name)`.
- **Tokens:** `[[CANDIDATE_FULL_NAME]]`, `[[JOB_TITLE]]`, `[[REQ_NUMBER]]`, `[[HIRING_MGR_FULL_NAME]]`, `[[RECRUITER_FULL_NAME]]`, `[[RECRUITER_EMAIL]]`, `[[INTERVIEW_DATETIME]]`, `[[INTERVIEW_LOCATION]]`, `[[OFFER_SALARY]]`, `[[OFFER_CURRENCY]]`, `[[START_DATE]]`, `[[LEGAL_ENTITY]]`, `[[LOGO]]`. An unknown token is an error, never output as raw text.
  - **Scopes:** email subjects may use the candidate and requisition tokens (`CANDIDATE_FULL_NAME`, `JOB_TITLE`, `REQ_NUMBER`, `HIRING_MGR_FULL_NAME`, `RECRUITER_FULL_NAME`, `RECRUITER_EMAIL`, `LEGAL_ENTITY`); email bodies those plus `LOGO`; offer bodies those plus `OFFER_SALARY`, `OFFER_CURRENCY` and `START_DATE`. Interview tokens are used only by the interview emails built in code. Templates are checked on save.
  - **Syntax:** names are case-sensitive; any other `[[…]]` is an unknown token; an unclosed `[[` is refused on save; resolved values are not resolved again; a known token without a value is an error.
  - **Output:** values are HTML-escaped in HTML bodies, inserted as-is in text bodies, and stripped of line breaks in subjects. Markup is rendered first, then tokens are filled in. `[[LOGO]]` is a `data:` image in HTML and empty in text.
  - **Formats:** dates `15 January 2027`; amounts `85,000.00` with the currency code separate; interview time in the interview's time zone with its name (I6); `LEGAL_ENTITY` is the master data label; in offers `JOB_TITLE` is the offer's job title.
- **Settings** (Admin-editable; defaults in brackets):

| Setting | Default | Allowed values |
|---|---|---|
| `RETENTION_DAYS` | 180 | integer 1–3650 |
| `REJECTION_EMAIL_DELAY_HOURS` | 24 | integer 0–168 |
| `APPROVAL_REMINDER_DAYS` | 3 | integer 1–30 |
| `MAX_UPLOAD_MB` | 5 | integer 1–10 (MiB) |
| `SENDER_EMAIL` | `careers@ats-demo.local` | valid email |
| `FALLBACK_REPLY_TO_EMAIL` | `recruiting@ats-demo.local` | valid email |
| `PRIVACY_STATEMENT_VERSION` | `1.0` | 1–20 characters |
| `PRIVACY_STATEMENT_TEXT` | demo statement | plain text, 1–20,000 characters |

Settings are read through one typed reader that returns the default above when no row exists. Seeded rows have `updated_by = NULL` and are shown as "Default", like missing rows. Changing the privacy statement text requires a new version, so `consent_version` always identifies the text the candidate saw. Each changed key writes one `SETTING_CHANGED` audit row with `details_json = { key }` only; unchanged keys write nothing.

- **User management:** create a user (email, name, one role), edit the name (the email can't change), change role, deactivate and reactivate. Deactivation is blocked while the user is the approver of a pending item (A5) and ends all their sessions. An Admin can't change their own role or deactivate themselves, and the last active Admin can't be demoted or deactivated. Audit actions: `USER_CREATED`, `USER_ROLE_CHANGED` (`fromRole`, `toRole`), `USER_DEACTIVATED`, `USER_REACTIVATED`. Other references to an inactive user stay in place: E2 falls back to `FALLBACK_REPLY_TO_EMAIL` when the requisition's recruiter is inactive; invite, update and cancel emails skip inactive participants (I2–I5); the requisition page shows a warning when its recruiter or hiring manager is inactive. All user pickers (approver, recruiter, hiring manager, interviewer) list **active users only**, optionally filtered by one or more roles.
- **Admin tools:** Outbox (`/admin/outbox`), background jobs and daily-task runs.

### 5.2 Job Requisitions

**Creation:** from a template, blank, or by duplicating an existing requisition (a create form prefilled from the source, including its active pre-screening questions). `req_number` is assigned on creation (`REQ-00001`, `REQ-00002`, …); gaps in the sequence are acceptable. The template can't change after creation. Department, Location and Legal Entity must be master data of that type; the recruiter must be a Recruiter or Admin and the hiring manager a Hiring Manager or Admin. Hiring Managers can edit only drafts they created. The description is rich text, sanitized with an allowlist on save and on display, and may be empty only in `DRAFT`.

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
| A3 Decision | The approver approves or rejects; a comment is required to reject. **Requisition, first approval** (`approved_at IS NULL`): approve → `APPROVED`, `approved_at = now()`, `is_published = true`; reject → `DRAFT`. **Requisition re-approval** (`approved_at IS NOT NULL`): approve → `APPROVED`, clear `previous_l2_values_json`, keep the original `approved_at`; reject → restore the L2 fields from `previous_l2_values_json`, clear it, `APPROVED`. **Offer:** approve → `APPROVED` (P7 renders the letter); reject → `REJECTED`, editable and resubmittable as `PENDING` only while it is the latest offer on the application (§5.6). |
| A4 Reassignment | Recruiters and Admins can reassign a pending approval to another eligible approver; a reason is required and A2 applies. |
| A5 Deactivation guard | A user who is the approver of any pending item (a requisition in `PENDING_APPROVAL` or an offer in `PENDING`) can't be deactivated, or have their role changed to one that can't approve (anything other than Hiring Manager or Admin), until those items are reassigned. Other references don't block deactivation (§5.1). |
| A6 Reminders | Daily: for each pending item, send a reminder when `now − last_event_at ≥ APPROVAL_REMINDER_DAYS`, where `last_event_at` is the latest `SUBMITTED`, `REASSIGNED` or `REMINDED` event for that item. To: approver; Cc: submitter. |
| A7 Audit | Every submission, approval, rejection, withdrawal, reassignment and reminder is written to `approval_events`. |
| A8 Offer re-approval | An offer can be edited only while `candidate_response = PENDING`; once `ACCEPTED` or `DECLINED` it is locked (after a decline, the recruiter creates a new offer). Changing the salary, currency or start date of an `APPROVED` offer requires the editor to pick an approver (A1, A2), sets `approval_status = PENDING` and clears `sent_at`; `candidate_response` stays `PENDING`. After re-approval, P7 renders a new letter and sends the updated offer email; the earlier PDF stays in history. |
| A9 Withdraw submission | The submitter, a Recruiter or an Admin can withdraw a pending item. Requisition first approval → `DRAFT`. Requisition re-approval → same effect as a rejection (L2 values restored). Offer → `approval_status = DRAFT`; the approval event `WITHDRAWN` means the approval **request** was recalled, not that the offer was cancelled (offer status `WITHDRAWN`, §5.6). |

**Lifecycle rules**

| Rule | Behaviour |
|---|---|
| L1 Free edits | While `APPROVED`, `ON_HOLD` or in re-approval, these fields can change without approval: title, description, location, recruiter, posting type, custom fields; pre-screening questions can be added (L3). The four L2 fields are not free edits (L2). |
| L2 Re-approval triggers | Only from `APPROVED`: increasing `openings_count`, or changing `department_id`, `hiring_manager_id` or `legal_entity_id`, saves the current values of those four fields in `previous_l2_values_json`, applies the change, sets `PENDING_APPROVAL` and starts a new approval (A1–A2). The posting stays published and the pipeline stays workable. The four L2 fields are editable only in `DRAFT` (freely) and `APPROVED` (as described here); they are locked in `ON_HOLD`, `PENDING_APPROVAL` (including re-approval) and `CLOSED`. Decreasing `openings_count` needs no approval but can't go below the number already hired; lowering it to equal the number of hired applications (≥ 1) closes the requisition immediately with `close_reason = FILLED` (R6), in the same transaction as the edit. |
| L3 Pre-screening edits | Once any application has answered a question, the question can't be deleted and its type, options, weight, scoring answer and disqualifying answer can't change; it can be deactivated. New questions can be added at any time. |
| L4 On Hold | `APPROVED → ON_HOLD`: `is_published = false`, `on_hold_since = now()`. Applications can still be moved between open stages and rejected. |
| L5 Resume | `ON_HOLD → APPROVED`: add `(now − on_hold_since)` in days (2 decimals) to `paused_days`, clear `on_hold_since`, `is_published = true`. |
| L6 Close | `close_reason` is `FILLED` (automatic, R6) or `CANCELLED` (manual from `APPROVED` or `ON_HOLD`, comment required). On close: if `ON_HOLD`, first add the hold time to `paused_days` as in L5; all open applications become `REJECTED` (`reason_code` `REQ_FILLED` / `REQ_CANCELLED`) with the rejection email per E8; non-final offers become `WITHDRAWN`; `is_published = false`; `closed_at = now()`. |
| L7 Reopen | Admin only, comment required: `CLOSED → APPROVED`; add `(now − closed_at)` in days (2 decimals) to `paused_days`, then clear `closed_at` and `close_reason` (the earlier close stays in history); `is_published = true`. Auto-rejected applications are not restored automatically (use R3). |
| L8 Blocked actions | While a requisition is `ON_HOLD` or `PENDING_APPROVAL`, it is not possible to create, submit or approve offers, or to move an application to `HIRED`. A requisition in first-approval `PENDING_APPROVAL` can't be edited at all (use A9 to withdraw it first). |
| L9 Publishing | `is_published` becomes `true` on first approval (A3), resume (L5) and reopen (L7), and `false` on hold (L4) and close (L6). While `APPROVED`, a Recruiter can unpublish or republish manually. When `posting_type = 'PRIVATE'` and `private_slug` is empty, a slug of 32 random hex characters is generated on save; the slug is kept when the posting switches to External. |
| L10 KPIs | **Time to Fill** (only `close_reason = FILLED`) = `closed_at − approved_at − paused_days`. **Age of Requisition** (open requisitions) = `now − approved_at − paused_days − current hold`, where current hold = `now − on_hold_since` while `ON_HOLD`. `paused_days` is the total time spent on hold (L5, L6) and closed before a reopen (L7). |
| L11 Audit | Creation, every state change and every L2 field change are written to `requisition_history`. |

**Postings:** `EXTERNAL` postings are listed on the public job board. `PRIVATE` postings are reachable only through `/jobs/p/{private_slug}`, carry `noindex`, and are excluded from listings, search and the sitemap. Private postings are how internal vacancies are shared with employees.

### 5.3 Career Portal & Candidate Intake

- **Job board:** mobile-friendly list rendered on the server at request time, with keyword search and filters by Location and Department. Shows requisitions where `posting_type = 'EXTERNAL' AND is_published = true`.
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
| S4 Totals | Per-question points are stored in `prescreen_answers.points`; `applications.prescreen_score` is their sum. Only active questions are shown and scored. An unanswered question scores 0 and doesn't disqualify; an unknown option code is an error; multiple-choice answers are compared as sets. |

**Question rules:** `YES_NO` has the fixed options `YES`/`NO`; `SINGLE` and `MULTI` have 2–20 options with codes `^[A-Z0-9_]{1,30}$`, unique within the question; `TEXT` has no options, weight 0 and no scoring or disqualifying answer (S1). Answers use only the question's own codes; the scoring and disqualifying answers must differ (`MULTI`: disjoint sets). A weight above 0 requires a scoring answer and vice versa; weight is 0–100; question text 1–500 characters; at most 50 questions per requisition. Questions can be added or changed in `DRAFT`, `APPROVED`, `ON_HOLD` and re-approval (subject to L3), never in first-approval `PENDING_APPROVAL` (L8) or `CLOSED`.

**Files & anti-spam**

| Rule | Behaviour |
|---|---|
| F1 Formats | CV, cover letter and interview notes: **PDF only**. |
| F2 Size | Max `MAX_UPLOAD_MB` per file (1 MB = 1 MiB), checked in the browser and on the server. Empty files are rejected. |
| F3 Content check | The server verifies the `%PDF-` file signature at byte 0 and ignores the file extension and the browser-sent MIME type. It rejects any encrypted PDF (including permissions-only encryption) and any file that can't be parsed as a PDF. |
| F4 Storage | Files are stored in a private container under random keys and are reachable only through signed links (V11). |
| F5 Viewing | PDFs open inline through direct signed Blob links; the signed link sets the response headers `Content-Type: application/pdf` and `Content-Disposition: inline`. The restrictive Content Security Policy and `X-Content-Type-Options: nosniff` apply to all **app pages**, including those that embed the PDF viewer; `frame-src` allows only the configured Blob origin (never `*`). |
| F6 Anti-spam | The apply endpoint is rate-limited to 5 submissions per IP per hour (counted in the `rate_limits` table; client IP resolved as in `tech-stack.md` §3), protected by Cloudflare Turnstile, and includes a hidden honeypot field. |
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
| R6 Auto-close | When the number of hired applications reaches `openings_count` (through a hire, or by lowering `openings_count` per L2), the requisition closes with `close_reason = FILLED` (L6) in the same transaction. |
| R7 Pending email cancellation | Any status change cancels that application's queued, unsent emails (including a delayed rejection) in the same transaction, setting them to `CANCELLED`. |
| R8 History | Every change writes `application_history` (from, to, user, comment, reason code, `is_reopen`). |
| R9 Concurrency | Updates use optimistic locking; a stale update fails with "This record was changed by someone else. Reload and try again." |
| R10 Offer precondition | An offer can be created only when the application status is `OFFER`. |
| R11 Disposition date | `dispositioned_at` is set to `now()` whenever an application enters `REJECTED`, `WITHDRAWN` or `HIRED`, and cleared whenever it returns to an open status. `hired_at` is set on entering `HIRED`. |
| R12 Interview cancellation | When an application reaches a final status, its future `SCHEDULED` interviews are cancelled (I4). |

**Recruiter workbench**
- Application list per requisition with status, score and grouping by `email_hash`.
- Inline PDF viewer; a timeline per application showing status history, emails, interviews, scorecards and offers.
- Optional comment on every status change. Status changes, interview scheduling and offer actions are available to Recruiters and Admins only (§3).
- **Bulk actions:** move status or send a templated email to selected applications. Bulk email offers only active `EMAIL` templates with `trigger_status IS NULL`, sent as-is with tokens resolved; there is no editing at send time. The seed ships two: "Application update" and "Interview preparation". Each application is validated individually against R1–R12; the result is reported per application.

### 5.5 Interviews & Scorecards

| Rule | Behaviour |
|---|---|
| I1 Data | An interview stores the start time (UTC), duration, IANA time zone (default: the recruiter's browser zone), location or meeting link, status (`SCHEDULED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`), a stable calendar UID and a sequence number starting at 0. Interviewers are stored as participants. |
| I2 Invite | On creation, a **separate** email with an `.ics` invite (`METHOD:REQUEST`, sent as an attachment and as `text/calendar`) goes to the candidate and to each interviewer. Each invite lists only its recipient as attendee. The organizer is `SENDER_EMAIL`. Inactive users are skipped as recipients of invite, update and cancel emails (I2–I5). |
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
- **Two meanings of "withdrawn":** the approval event `approval_events.event = 'WITHDRAWN'` means the approval **request** was recalled (A9) and the offer returns to `approval_status = 'DRAFT'`. The offer status `offers.approval_status = 'WITHDRAWN'` means the **offer itself** is permanently cancelled: set automatically when the requisition closes (L6) or manually through Discard offer.
- **Discard offer:** Recruiter or Admin only, allowed from `DRAFT` or `REJECTED`; sets `approval_status = WITHDRAWN` and writes `OFFER_DISCARDED` to `audit_log`.
- **One active offer per application:** a new offer can be created only when every earlier offer is `REJECTED`, `WITHDRAWN` or declined. Creating a new offer immediately freezes all earlier offers: they are read-only, kept in history and can no longer be edited or resubmitted. A `REJECTED` offer can be edited and resubmitted only while it is the latest offer on the application.
- **Editing:** only while `candidate_response = PENDING`; accepted or declined offers are locked (A8).
- **Approval:** A1–A4, A8, A9.
- **Letter:** after approval the letter is rendered as PDF from the offer template, stored, and emailed to the candidate with the PDF attached.
- **Response:** the recruiter records `ACCEPTED` or `DECLINED`. Declined: the application stays in `OFFER` (new offer, back to `INTERVIEW`, or reject). Accepted: the application can move to `HIRED` (R2, R5).
- **Hire export:** CSV of hired applications (name, email, phone, job title, department, location, legal entity, start date, salary, currency, hired date). By default the export contains hires not yet exported and not anonymized (`status = 'HIRED' AND exported_at IS NULL AND anonymized_at IS NULL`); the option "Include already exported" (`?includeExported=true`) adds earlier exports that aren't anonymized. Exporting sets `exported_at` on rows exported for the first time (re-exports keep the original value) and is recorded in the audit log. Recruiter and Admin only.

### 5.7 Email

| Rule | Behaviour |
|---|---|
| E1 Sender | Every email is sent from `SENDER_EMAIL` through one email service. |
| E2 Reply-To | The **current** recruiter of the requisition at the moment of sending; if none or inactive, `FALLBACK_REPLY_TO_EMAIL`. Content is rendered when the email is queued; From, Reply-To and the footer are added when it is sent. |
| E3 Footer | Candidate emails include `[[RECRUITER_EMAIL]]` and the line "Reply to this email to reach your recruiter." `[[RECRUITER_EMAIL]]` always equals the Reply-To address; when the recruiter is inactive, `[[RECRUITER_FULL_NAME]]` becomes "the recruiting team". |
| E4 Email log | Every email is recorded in `email_log` with its full content, `.ics`, attachment references, status and timestamps, and appears on the application timeline. |
| E5 Retries | Sending is retried with backoff; only after the final retry fails is the status `FAILED`, and the application shows a warning. An email whose application has been anonymized is cancelled, not sent. |
| E6 Capture | Emails are never delivered to real recipients (C4). With `EMAIL_PROVIDER=smtp` (Mailpit, local/CI) a handled email gets status `SENT`; with `EMAIL_PROVIDER=outbox` (Azure) it gets `CAPTURED` and is viewable in the Outbox (Admin only). |
| E7 Internal notifications | Approval requests, reminders and interview assignments use the same service and log. |
| E8 Stage emails | A status change sends an email **only** if an active email template exists with `trigger_status` equal to the new status (`trigger_status` can't be `INTERVIEW` or `OFFER`, E9). Shipped templates: `APPLIED` (acknowledgement, immediate) and `REJECTED` (sent after `REJECTION_EMAIL_DELAY_HOURS`). |
| E9 Flow emails | Interview emails come only from I2–I5 and offer emails only from the offer flow (§5.6). Moving an application to `INTERVIEW` or `OFFER` sends nothing by itself. |

### 5.8 Privacy & Data Retention

| Rule | Behaviour |
|---|---|
| RT1 Clock | Retention is counted from `dispositioned_at` (R11). |
| RT2 Selection | Daily, select applications where `anonymized_at IS NULL AND status IN ('REJECTED','WITHDRAWN','HIRED') AND (status <> 'HIRED' OR exported_at IS NOT NULL) AND dispositioned_at + RETENTION_DAYS < now()`. Open applications are never selected. |
| RT3 Application | Set `first_name`, `last_name`, `email`, `email_hash` and `phone` to NULL and `anonymized_at = now()`. Keep status, reason code, timestamps, `prescreen_score` and `is_disqualified`. |
| RT4 Related data | Cancel the application's queued emails (J2) first; delete the application's `prescreen_answers`; clear `application_history.comment` and `interview_scorecards.comments`; delete all linked files (CV, cover letter, interview notes, offer letters) from storage and set `files.deleted_at`; clear `recipient`, `cc`, `subject`, `body_rendered` and `ics_content` in its `email_log` rows; clear `approval_events.comment` for `OFFER` events of the application's offers; set `files.original_name = NULL` on the deleted files. Offer job title, salary, currency and start date are kept for reporting. `audit_log.details_json` holds IDs and counts only (`tech-stack.md` M2), so the purge doesn't touch it. |
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
| `retention.purge` | Daily, after 02:00 Europe/Warsaw | RT1–RT5; also deletes `rate_limits` rows older than 2 hours |

Timing is best-effort: the application sleeps when idle and is woken hourly, so scheduled work may run up to about one hour after its due time (`tech-stack.md` §6). Daily tasks are tracked per Europe/Warsaw calendar date (`job_runs.run_date`).

---

## 7. Data Model

**Conventions:** PostgreSQL 17; UUID primary keys (`id`), except `settings` (`key`) and `rate_limits` (`(key, window_start)`), which keep their natural keys; `created_at` and `updated_at` (`timestamptz`) on every table, including `settings`, `job_runs`, `rate_limits` and the append-only history tables; all times in UTC; enumerations stored as text with check constraints; every foreign key indexed; no `ON DELETE CASCADE` (related rows are deleted or cleared explicitly, e.g. by RT4). Polymorphic or external references (`files.owner_id`, `approval_events.subject_id`, `email_log.job_id`, `email_log.attachment_file_ids`, `applications.candidate_id`) have no foreign key.

| # | Table | Columns and constraints |
|---|---|---|
| 1 | **users** | `id`, `email` (unique, lower-case), `name`, `email_verified` (boolean, set `true` when an Admin creates the user), `image` (nullable), `role` (`ADMIN`, `RECRUITER`, `HIRING_MANAGER`, `INTERVIEWER`), `is_active` (default true). Shared with the authentication library (`tech-stack.md` §4). |
| 2 | **master_data** | `id`, `type` (`DEPARTMENT`, `LOCATION`, `LEGAL_ENTITY`, `PICKLIST`), `picklist_key` (nullable; check: set if and only if `type = 'PICKLIST'`), `code`, `label`, `is_active`. `UNIQUE NULLS NOT DISTINCT (type, picklist_key, code)`. |
| 3 | **templates** | `id`, `type` (`REQUISITION`, `EMAIL`, `OFFER`), `name`, `trigger_status` (nullable; `EMAIL` only), `subject` (nullable; `EMAIL`), `body` (nullable; `EMAIL`, `OFFER`), `schema_json` (jsonb, nullable; `REQUISITION`), `is_active`. `UNIQUE (type, name)`. Partial unique index on `(trigger_status) WHERE type = 'EMAIL' AND is_active AND trigger_status IS NOT NULL`. `schema_json` = `Array<{ key, label, type: 'TEXT'│'NUMBER'│'BOOLEAN'│'PICKLIST', picklist_key?, required }>`. |
| 4 | **settings** | `key` (PK), `value`, `updated_by` (nullable; NULL for seeded defaults), `updated_at`. |
| 5 | **requisitions** | `id`, `req_number` (unique; `'REQ-' ‖ lpad(nextval('req_number_seq')::text, 5, '0')`), `title`, `template_id` (nullable; requisitions can be created blank, §5.2), `department_id`, `location_id`, `legal_entity_id`, `hiring_manager_id`, `recruiter_id`, `created_by_user_id`, `submitted_by_user_id` (nullable), `submitted_at` (nullable), `approver_id` (nullable), `state` (`DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `ON_HOLD`, `CLOSED`), `close_reason` (`FILLED`, `CANCELLED`, nullable), `openings_count` (≥ 1), `description_html`, `custom_fields_json` (jsonb; `Record<string, string│number│boolean│null>`, validated against the template), limits: `title` 1–200 characters, `openings_count` ≤ 1000, `description_html` ≤ 50,000 characters, `posting_type` (`EXTERNAL`, `PRIVATE`), `private_slug` (unique, nullable), `is_published` (default false), `approved_at` (nullable), `previous_l2_values_json` (jsonb, nullable), `on_hold_since` (nullable), `paused_days` (`numeric(10,2)`, default 0), `closed_at` (nullable), `version`. |
| 6 | **requisition_history** | `id`, `requisition_id`, `event` (`STATE_CHANGE`, `FIELD_CHANGE`, `REOPEN`), `field`, `old_value`, `new_value`, `user_id`, `comment`, `created_at`. |
| 7 | **prescreen_questions** | `id`, `requisition_id`, `question_text`, `question_type` (`YES_NO`, `SINGLE`, `MULTI`, `TEXT`), `options_json` (array of `{ code, label }`), `weight` (int ≥ 0), `scoring_answer` (jsonb, nullable), `disqualifying_answer` (jsonb, nullable), `is_active`, `sort_order`. |
| 8 | **applications** | `id`, `requisition_id`, `candidate_id` (nullable, reserved), `first_name`, `last_name`, `email`, `email_hash`, `phone` (these five nullable), `status`, `reason_code` (nullable: `DISQUALIFIED`, `REQ_FILLED`, `REQ_CANCELLED`, `OTHER`), `source` (`CAREER_SITE`, `PRIVATE_LINK`), `prescreen_score`, `is_disqualified`, `consent_accepted_at`, `consent_version`, `applied_at`, `dispositioned_at`, `hired_at`, `exported_at`, `anonymized_at`, `version`. Check: `anonymized_at IS NOT NULL OR (first_name, last_name, email, email_hash, phone all NOT NULL)`. Index `(requisition_id, email_hash, applied_at)`. |
| 9 | **prescreen_answers** | `id`, `application_id`, `question_id`, `answer_json`, `points`. |
| 10 | **application_history** | `id`, `application_id`, `from_status` (nullable; NULL on the entry written when the application is created), `to_status`, `changed_by_user_id` (nullable = system), `comment` (nullable), `reason_code`, `is_reopen`, `created_at`. |
| 11 | **files** | `id`, `owner_type` (`APPLICATION`, `SCORECARD`, `OFFER`), `owner_id`, `kind` (`CV`, `COVER_LETTER`, `INTERVIEW_NOTES`, `OFFER_LETTER`), `mime`, `size_bytes`, `original_name` (`text`, nullable; the uploaded file name, personal data, cleared by RT4), `storage_key`, `status` (`CLEAN`; reserved `PENDING_SCAN`, `QUARANTINED`), `deleted_at`. |
| 12 | **interviews** | `id`, `application_id`, `starts_at_utc`, `duration_minutes`, `timezone`, `location_or_link`, `status`, `ics_uid` (unique), `ics_sequence`, `created_by_user_id`. |
| 13 | **interview_participants** | `id`, `interview_id`, `user_id`, `removed_at` (nullable). `UNIQUE (interview_id, user_id)`. |
| 14 | **interview_scorecards** | `id`, `interview_id`, `interviewer_id`, `overall_rating` (1–5), `thumbs_up`, `comments` (nullable), `submitted_at` (nullable), `reopened_at` (nullable). `UNIQUE (interview_id, interviewer_id)`. |
| 15 | **offers** | `id`, `application_id`, `template_id`, `created_by_user_id`, `submitted_by_user_id` (nullable), `submitted_at` (nullable), `approver_id` (nullable; check: `approval_status IN ('DRAFT', 'WITHDRAWN') OR approver_id IS NOT NULL`, because a discarded or auto-withdrawn draft (§5.6, L6) never had an approver), `job_title`, `salary` (`numeric(12,2)`), `currency` (ISO 4217; check `^[A-Z]{3}$`, the code list is validated in the offer service), `start_date`, `approval_status`, `candidate_response`, `sent_at`, `responded_at`. |
| 16 | **approval_events** | `id`, `subject_type` (`REQUISITION`, `OFFER`), `subject_id`, `event` (`SUBMITTED`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `REASSIGNED`, `REMINDED`), `actor_user_id` (nullable = system), `from_approver_id`, `to_approver_id`, `comment`, `created_at`. Index `(subject_type, subject_id, created_at)`. |
| 17 | **email_log** | `id`, `application_id` (nullable), `requisition_id` (nullable, foreign key), `audience` (`CANDIDATE`, `STAFF`), `template_id` (nullable), `job_id` (nullable), `recipient` (nullable after purge), `cc` (`text`, nullable), `reply_to`, `subject` (nullable), `body_rendered` (nullable), `ics_content` (nullable), `attachment_file_ids` (uuid[], default `{}`), `status` (`QUEUED`, `SENT`, `CAPTURED`, `FAILED`, `CANCELLED`), `scheduled_for`, `sent_at`, `provider_message_id`, `ics_uid`, `ics_sequence`, `direction` (`OUTBOUND`), `error`. |
| 18 | **audit_log** | `id`, `actor_user_id` (nullable = system), `action` (free text, no check constraint; e.g. `EXPORT_HIRES`, `USER_CREATED`, `USER_ROLE_CHANGED`, `USER_DEACTIVATED`, `USER_REACTIVATED`, `ADMIN_SEEDED`, `SETTING_CHANGED`, `OFFER_DISCARDED`), `subject_type` (nullable, no check), `subject_id` (nullable), `details_json` (IDs and counts only, never personal data), `created_at`. |
| 19 | **job_runs** | `id`, `job_name`, `run_date` (`date`, Europe/Warsaw calendar date), `started_at`, `finished_at` (nullable), `status` (`RUNNING`, `COMPLETED`, `FAILED`). `UNIQUE (job_name, run_date)`. |
| 20 | **rate_limits** | `key`, `window_start`, `count`. Primary key `(key, window_start)`. Rows older than 2 hours are deleted by the daily purge (§6). |
| — | **Authentication tables** | `session`, `account`, `verification`: owned by the authentication library (`tech-stack.md` §4), but follow the conventions above (snake_case, UUID keys, timestamps, indexed foreign keys, no `ON DELETE CASCADE`). |
| — | **Job queue tables** | Owned by pg-boss in its own schema (`tech-stack.md` §5). |

---

## 8. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Security | HTTPS only; private file storage with short-lived signed links; secrets never in code; restrictive Content Security Policy; all authorization server-side (V9). |
| Privacy | Logs contain identifiers only, never personal data. |
| Accessibility | Keyboard-navigable forms with labels; WCAG 2.1 AA colour contrast on the career portal. |
| Performance | Job board and job pages rendered on the server at request time; typical page response under 1 s once the app is awake. |
| Availability | Demo-grade: the app sleeps when idle; the first request after idle can take several seconds. |
| Browsers | Current Chrome, Edge, Firefox and Safari; mobile-friendly career portal. |
| Language & formats | English UI; dates displayed in the user's locale; currency as ISO code + amount. |
| Testability | Every rule ID listed as required in `tech-stack.md` T1 has at least one automated test. |

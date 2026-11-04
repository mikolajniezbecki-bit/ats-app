# ATS Demo User Manual

A guide for HR professionals, recruiters, hiring managers and business evaluators testing the platform. All labels below are written exactly as they appear on screen, in **bold**.

All people, jobs and documents in the demo are fictional. Please use made-up data only.

## 1. Welcome & Platform Overview

This is an Applicant Tracking System (ATS). It covers hiring from the first job request to the signed-off hire, in two parts:

1. **Public Career Portal (`/jobs`)**: candidates find open positions and apply. They don't need an account.
2. **Internal Back Office**: Recruiters, Hiring Managers, Interviewers and Admins run the process, from requisition approval to offer and hire.

### Safe Demo Mode: no real emails

The system never sends real emails to the internet. Every email is built in full, then kept for inspection:

- **Admin -> Outbox** lists every email: candidate notifications, calendar invites (`.ics`) and offer emails with the Offer Letter PDF. Only Admins can open it.
- On a local demo, you can also read the emails in the mailbox viewer at `http://localhost:8025`.
- The status differs by setup: **Sent** on a local demo, because they go to that viewer, and **Captured** on the cloud demo. Neither reaches a real person.

The Outbox is **empty when you start**, because the sample data contains no past emails. Emails appear as you test. If one is missing, reload the page and wait a minute.

## 2. Quick-Start Demo Accounts & Pre-Loaded Test Data

### Where to sign in

These accounts work on the **local demo** at `http://localhost:3000/sign-in`. To start it, follow "Option B" in [`README.md`](README.md) or ask your technical contact. The password for all four is `local-only-not-secret-demo`.

The cloud demo's staff area only accepts Microsoft accounts from the project's own directory, so testers without such an account can only use its public Career Portal.

| Account | Shown as | Menu after signing in |
|---|---|---|
| `admin@ats-demo.local` | Demo Admin | **Home**, **Administration**, **Settings**, **Master data**, **Users**, **Templates**, **Outbox**, **Jobs**, **Requisitions**, **My approvals**, **All pending approvals**, **Exports**, **Reports**, **My interviews** |
| `recruiter@ats-demo.local` | Demo Recruiter | **Home**, **Requisitions**, **All pending approvals**, **Exports**, **Reports**, **My interviews** |
| `hm@ats-demo.local` | Demo Hiring Manager | **Home**, **Requisitions**, **My approvals**, **My interviews** |
| `interviewer@ats-demo.local` | Demo Interviewer | **Home**, **My interviews** |

The **Home** page only shows your name and role, so go straight to the menu. To switch account, click **Sign out**, or use a private browser window for each account.

### Sample requisitions

Every sample job title ends in "(synthetic)".

| Requisition | State | Good for |
|---|---|---|
| Data Analyst | **Draft** | Editing and submitting. Its description is empty, so add one first |
| Finance Controller | **Pending approval** | Approving as Demo Hiring Manager |
| Sales Representative | **Pending approval** | A re-approval: **Openings: 1 → 2**. The job stays live meanwhile |
| Backend Engineer | **Approved**, 3 openings | The main test job: 10 candidates at every stage |
| Product Designer | **Approved**, 2 openings, **Private (link only)** | A job that's hidden from the job board |
| People Partner | **On hold** | Resuming a paused job |
| QA Engineer | **Closed**, **Filled** | A finished hire |
| Account Manager | **Closed**, **Cancelled** | A cancelled job, which an Admin can **Reopen** |

On the public job board you'll see **Backend Engineer** and **Sales Representative**.

### Sample candidates

| Job | Candidate | Status | Notes |
|---|---|---|---|
| Backend Engineer | Bruno Example | **Applied** | |
| Backend Engineer | Celina Placeholder | **Applied** | Answered only some questions |
| Backend Engineer | Ada Sample | **Screening** | Has a cover letter. Also applied to People Partner |
| Backend Engineer | Dawid Testcase | **Interview** | Has two interviews (see below) |
| Backend Engineer | Ewa Demo | **Offer** | Draft offer |
| Backend Engineer | Filip Sample | **Offer** | Offer awaiting approval. Has a cover letter |
| Backend Engineer | Greta Example | **Offer** | Offer sent, no response yet |
| Backend Engineer | Henryk Placeholder | **Hired** | Already exported |
| Backend Engineer | Iga Testcase | **Rejected** | Disqualified by pre-screening |
| Backend Engineer | Jonas Demo | **Withdrawn** | |
| Product Designer | Kira Sample | **Applied** | Came through the private link |
| Product Designer | Leon Example | **Interview** | Has a cover letter. Good for the scorecard privacy test |
| Product Designer | Ada Placeholder | **Hired** | Not exported yet |
| Sales Representative | Bruno Testcase | **Screening** | |
| Sales Representative | Celina Demo | **Applied** | |
| People Partner | Ada Sample | **Screening** | Same person as on Backend Engineer |
| People Partner | Dawid Sample | **Rejected** | |
| QA Engineer | Ewa Example | **Hired** | |
| QA Engineer | Filip Placeholder, Greta Testcase | **Rejected** | Requisition filled |
| Account Manager | Henryk Demo | **Rejected** | Requisition cancelled |
| Account Manager | Iga Sample | **Withdrawn** | |

### Sample interviews

| Candidate | When | Who takes part | What to do |
|---|---|---|---|
| Dawid Testcase | 2 days ago | Demo Interviewer | Shows **Awaiting outcome**, with a scorecard to fill |
| Dawid Testcase | In 3 days | Demo Recruiter, Demo Interviewer | The scorecard isn't available until it starts |
| Leon Example | 5 days ago, **Completed** | Demo Interviewer, Demo Hiring Manager | The Hiring Manager has already submitted (4 of 5, thumbs up). The Interviewer hasn't |

Ewa Demo, Filip Sample, Greta Example and the three hired candidates each have a completed interview with a submitted scorecard (5 of 5, thumbs up).

### Sample offers

| Candidate | Offer | State |
|---|---|---|
| Ewa Demo | 78,000.00 EUR | Approval: **Draft** |
| Filip Sample | 85,000.00 PLN | Approval: **Awaiting approval** by Demo Hiring Manager |
| Greta Example | 85,000.00 EUR | Approval: **Approved**, letter sent, **No response yet** |
| Henryk Placeholder, Ada Placeholder, Ewa Example | 85,000.00 EUR | Accepted |

## 3. Roles & Permissions Matrix ("Who Can Do What?")

| Capability | Candidate (Public) | Interviewer | Hiring Manager | Recruiter | Admin |
|---|---|---|---|---|---|
| Browse jobs and apply | Yes | Yes | Yes | Yes | Yes |
| See requisitions | No | No | Only their own | All | All |
| Create a requisition | No | No | Yes | Yes | Yes |
| Edit a requisition | No | No | Only drafts they created | Yes | Yes |
| Approve or reject | No | No | When they are the approver | No | When they are the approver |
| Publish, hold, close | No | No | No | Yes | Yes |
| Reopen a closed requisition | No | No | No | No | Yes |
| See applications | No | Only with an interview | Read-only, their requisitions | All | All |
| Change a candidate's status | No | No | No | Yes | Yes |
| Schedule interviews | No | No | No | Yes | Yes |
| Fill in a scorecard | No | When taking part | When taking part | When taking part | When taking part |
| Create offers | No | No | No | Yes | Yes |
| See offers and salary | No | Never | Their requisitions | All | All |
| Reports and Exports | No | No | No | Yes | Yes |
| Outbox, Settings, Master data, Templates, Users | No | No | No | No | Yes |

- **Candidate (Public):** no account and no login. Candidates can't check their status afterwards. Everything they hear comes by email.
- **Interviewer:**
  - Sees only candidates they are interviewing.
  - Sees the CV, cover letter, name, email, phone, job title and their own interviews.
  - Never sees offers, salary, pre-screening answers or score, the candidate's status, comments, or other applications by that person.
  - Can't see other interviewers' scorecards until they've submitted their own.
  - Loses access as soon as the candidate is **Hired**, **Rejected** or **Withdrawn**.
- **Hiring Manager:**
  - Sees requisitions where they are the hiring manager, the approver or the creator. Other requisitions don't exist for them.
  - Reads applications but can't change them.
  - Can't approve anything they submitted themselves. Nobody can.
- **Recruiter:** runs the whole hiring process, but can't approve and has no **Outbox**. Recruiters read each candidate's emails on the application's **Timeline**, using **View**.
- **Admin:** everything a Recruiter can do, plus system management, reopening closed requisitions, correcting a hire, and reopening submitted scorecards.

## 4. Step-by-Step Functional Walkthroughs (HR Testing Scripts)

Run the workflows in order. They change the sample data, and the last steps of Workflow E close Backend Engineer.

### Workflow A: Creating, Approving & Publishing a Job Requisition

**As Demo Recruiter:**

1. Click **Requisitions** -> **New requisition**.
2. Choose **Template**: **Standard requisition**.
3. Fill in **Job title**, **Department**, **Location**, **Legal entity**, **Hiring manager** (Demo Hiring Manager), **Recruiter** and **Openings**, which is the headcount.
4. Under custom fields, choose **Employment type** (required). **Seniority**, **Remote work allowed** and **Cost center** are optional. There's no separate work mode field: use **Remote work allowed**, or the **Remote** location.
5. Write a **Description**, then click **Save requisition**. It's now a **Draft**.
6. Optional: under **Pre-screening questions**, click **Add question**.
7. Click **Submit for approval**, choose an **Approver** (Demo Hiring Manager), and click **Submit**. Approval has a single step with one approver, so there's no multi-level chain.

The page now shows "Awaiting approval by Demo Hiring Manager", and the requisition can't be edited.

**As Demo Hiring Manager:**

8. Click **My approvals**, then the requisition's number.
9. Click **Approve**, and confirm with **Approve**.
   - To test a rejection, click **Reject**, type a **Comment** (required), and click **Reject**. The requisition goes back to **Draft**, so the Recruiter can edit and resubmit it.

**What happens next:** approval publishes the job automatically, so there's no separate publish step. Open `/jobs` to see it. A Recruiter can use **Unpublish** and **Republish** afterwards.

**Also try:** as Demo Hiring Manager, approve **Finance Controller** and **Sales Representative** from **My approvals**. The second shows **Re-approval** and **Openings: 1 → 2**.

### Workflow B: The Candidate Journey on the Career Portal

Use a private browser window, with no sign-in.

1. Open `/jobs`.
2. Use **Keywords**, **Location** and **Department**, then click **Search**. **Clear filters** resets them.
3. Click a job to read its description. Backend Engineer is a good one to use.
4. Click **Apply now**.
5. Fill in **First name**, **Last name**, **Email** and **Phone**, using made-up details. Example: "Test Person", `test@example.com`.
6. Upload a **CV (PDF)**. **Cover letter (PDF, optional)** is optional. Only PDF files are accepted.
7. Answer the questions. Answering "No" to "Are you allowed to work in the European Union?" disqualifies the applicant.
8. Read the privacy statement and tick the box that begins **I have read the privacy statement**.
9. Wait for the robot check to finish, then click **Submit application**.

**What happens next:** the **Thank you** page appears, and a confirmation email is created. The application shows as **Applied** in the Back Office. Even a disqualified candidate sees the same page, then receives a rejection email after a delay.

> **Not included:** candidates get no status link, no self-service withdrawal and no erasure request page, as they have no account. To record a withdrawal, a Recruiter sets the status to **Withdrawn**. Personal data is removed by the automatic retention process (Workflow F).

**Also try:** applying again with the same email within 24 hours shows "You have already applied for this position."

### Workflow C: Recruiter Workbench & Screening Candidates

**As Demo Recruiter:**

1. Click **Requisitions**, then **Backend Engineer**.
2. Click **Applications (…)**. The pipeline is a list, not a board. Use the status filters, such as **Applied (2)**, to narrow it.
3. Note **Score**, which comes from the pre-screening answers, and **Source**. Click **Open** on **Bruno Example**.
4. Review the details. The **CV** shows inside the page, below the candidate's details rather than beside them. Scroll down for **Pre-screening** and the **Timeline**.
5. Under **Change status**, choose **New status**: **Screening**. Optionally add a **Comment**, then click **Change status**.
6. Repeat with **Interview**.

There's no separate team notes feature. The **Comment** on a status change is how the team leaves notes, and it appears on the **Timeline**. Candidates never see it.

**To reject:**

7. Open **Celina Placeholder**, choose **Rejected**, and click **Change status**.

**What happens next:** the "Application rejected" email is scheduled for 24 hours later, and the **Timeline** shows "Scheduled for…". This gives you time to change your mind: changing the status again cancels the email. You don't pick a reason or a template when rejecting, because the email comes from the template set up by the Admin.

**Also try:**

- Tick several candidates in the list for **Move status** or **Send email**.
- Open **Ada Sample** to see **Other applications by this candidate**.

### Workflow D: Scheduling Interviews & Submitting Scorecards

**As Demo Recruiter:**

1. Open **Bruno Example** and click **Schedule interview**.
2. Fill in **Date and start time**, **Time zone**, **Duration (minutes)** and **Location or meeting link**.
3. Under **Participants**, tick **Demo Interviewer**, then click **Schedule**.

**What happens next:** separate invitations are created for the candidate and the interviewer. The candidate's status doesn't change by itself.

**As Demo Admin:**

4. Click **Outbox**, then **Open** on the interview email.
5. Click **Download invite (.ics)**.

**As Demo Interviewer:**

6. Click **My interviews**. A future interview can't have a scorecard yet: it says "Feedback can be given once the interview has started."
7. On **Dawid Testcase**'s interview from 2 days ago, click the **Scorecard** link.
8. Choose **Recommendation** (**Thumbs up** or **Thumbs down**) and **Overall rating** (1 to 5 of 5). Optionally add **Comments**.
9. Click **Save draft** if you want to finish later, then **Submit**. A submitted scorecard can't be changed.

The scorecard is deliberately simple: one recommendation and one overall rating, with no per-criterion ratings. Thumbs up or down acts as the hire or no-hire recommendation.

**Privacy test, still as Demo Interviewer:**

10. Open **Leon Example** from **My interviews**. The Hiring Manager's scorecard isn't visible.
11. Submit your own scorecard for that interview, then reopen the application. It's now visible.

**As Demo Recruiter:**

12. Open **Dawid Testcase**. The **Feedback** section shows the average rating and the thumbs count.
13. On the past interview marked **Awaiting outcome**, click **Completed**, or **No-show**.

### Workflow E: Creating, Approving & Sending a Job Offer (to Hire)

**As Demo Recruiter:**

1. Open **Dawid Testcase**, and use **Change status** to move them to **Offer**. An offer can only be created at this stage.
2. Click **Create offer**.
3. Check **Job title**, then fill in **Gross annual salary**, **Currency** and **Start date**, and choose the **Offer template**. Any other terms come from the template's text.
4. Click **Create offer**, then **Preview PDF** to see the letter.
5. Click **Submit for approval**, choose **Demo Hiring Manager** as **Approver**, and submit.

**As Demo Hiring Manager:**

6. Click **My approvals**. Under **Offers** you'll see Dawid's offer and **Filip Sample**'s.
7. Open each one, click **Approve**, and confirm.

**What happens next:** the system creates the Offer Letter PDF and an email to the candidate with the letter attached. The offer then shows **Letter sent**.

**As Demo Admin:**

8. Click **Outbox** and open the offer email. Under **Attachments**, open the PDF.

**As Demo Recruiter, recording decisions:**

9. On **Filip Sample**, click **Record response**, choose **Declined**, and click **Save response**. This can't be undone. There's no "Offer Declined" status: the candidate stays in **Offer**, so you can create a new offer, move them back, or reject them.
10. On **Dawid Testcase**, record **Accepted**.
11. Use **Change status** to choose **Hired**. **Hired** only appears once an offer has been accepted.
12. Do the same for **Greta Example**: record **Accepted**, then **Hired**.

**What happens next:** Backend Engineer has 3 openings, and Henryk Placeholder, Dawid and Greta fill them all. The requisition closes automatically as **Closed**, **Filled**, and leaves the job board. Remaining open candidates are rejected, and their pending offers are withdrawn.

To close a job by hand instead, a Recruiter uses **Close** with a comment, which gives **Closed**, **Cancelled**. **People Partner** is a good one to try: click **Resume** first, or close it directly.

### Workflow F: Administration, Governance, KPIs & GDPR Compliance

**KPIs and exports (Demo Recruiter or Demo Admin):**

1. Click **Reports**, not **Home**. You'll see **Open requisitions**, **Active applications per status**, **Average Time to Fill (days)**, **Average Time to Hire (days)** and **Age of open requisitions (days)**. Active applications per status is the closest thing to a funnel; there's no funnel chart.
2. Click **Exports**. Download the **Hire export**, and **Requisitions (CSV)** or **Pipeline (CSV)**.

**Master data and templates (Demo Admin):**

3. Click **Master data** to manage **Departments**, **Locations**, **Legal entities** and **Picklists**. Records in use can only be deactivated.
4. Rejection reasons are fixed by the system, so they aren't listed there.
5. Click **Templates** to see **Requisition templates**, **Email templates** and **Offer templates**.

**Users (Demo Admin):**

6. Click **Users**. Under **Add user**, enter **Email**, **Name** and **Role**, then click **Add user**. No invitation email is sent.
7. Use **Change role** or **Deactivate** on a row. A deactivated user loses access on their next click.

A new user signs in with their Microsoft account on the cloud demo. On the local demo they can't sign in, because there's no password screen, so test with the four demo accounts.

**Outbox (Demo Admin):**

8. Click **Outbox**. Filter by **Status**: **Queued**, **Sent**, **Captured**, **Failed** or **Cancelled**.
9. Click **Open** on an email for its body, **Download invite (.ics)**, and **Attachments**.

**Audit and retention (Demo Admin):**

10. There's no single audit screen. The history sits with each record: the **Timeline** on an application, the latest decision under **Approval** on a requisition, and the **Outbox** for emails.
11. Click **Settings** to see **Retention period (days)**, 180 by default.
12. Click **Jobs** to see **Daily-task runs (last 30 days)**.

**How GDPR retention works:**

- A daily task finds **Rejected**, **Withdrawn** and **Hired** applications whose final decision is older than the retention period. Hired ones must also have been exported.
- It removes the candidate's name, email and phone, their pre-screening answers, comments and all their documents.
- The application stays for reporting, labelled **Anonymized applicant**, with the note "Removed under the retention policy". Open applications are never touched.

The sample data is under 60 days old and this runs once a day, so you won't see it happen in a short test.

## 5. 30-Minute End-to-End HR Acceptance Test Checklist

**Portal (5 min)**

- [ ] `/jobs` lists Backend Engineer and Sales Representative, but not Product Designer
- [ ] **Keywords**, **Location** and **Department** filters work
- [ ] An application with made-up data reaches the **Thank you** page

**Requisitions and approvals (5 min)**

- [ ] Demo Recruiter creates a requisition and submits it
- [ ] Demo Hiring Manager rejects with a comment, and it returns to **Draft**
- [ ] After resubmission and approval, the job appears on `/jobs`
- [ ] Demo Hiring Manager approves **Sales Representative** (**Openings: 1 → 2**)

**Screening (5 min)**

- [ ] The CV shows inside the application page for **Bruno Example**
- [ ] **Bruno Example** moves to **Screening**, then **Interview**, and the **Timeline** records it
- [ ] Rejecting **Celina Placeholder** shows the email scheduled for later

**Interviews and scorecards (5 min)**

- [ ] An interview is scheduled, and its `.ics` downloads from the **Outbox**
- [ ] Demo Interviewer's menu shows only **Home** and **My interviews**
- [ ] Demo Interviewer submits a scorecard for **Dawid Testcase**
- [ ] On **Leon Example**, the other scorecard appears only after submitting
- [ ] Demo Interviewer sees no offer, salary or status

**Offers and hire (5 min)**

- [ ] Demo Recruiter creates an offer for **Dawid Testcase** and previews the PDF
- [ ] Demo Hiring Manager approves it, and the offer email with PDF is in the **Outbox**
- [ ] **Declined** on **Filip Sample** keeps them in **Offer**
- [ ] **Hired** is only available after **Accepted**
- [ ] After Dawid and Greta are hired, Backend Engineer is **Closed**, **Filled** and off `/jobs`

**Governance (5 min)**

- [ ] **Reports** shows the KPIs
- [ ] **Exports** downloads the hire file
- [ ] **Master data**, **Templates** and **Settings** open for Demo Admin
- [ ] Demo Recruiter has no **Outbox** or **Settings** in the menu
- [ ] Demo Hiring Manager can't change a candidate's status

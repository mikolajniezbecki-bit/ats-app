// What `db:seed` inserts in every environment (tech-stack.md D8). All data
// is synthetic (ats-project-scope.md C3). Kept in one module so the synthetic
// requisitions of task 42 can extend it.
import type { MASTER_DATA_TYPES, USER_ROLES } from "../schema";

type MasterDataSeed = { type: (typeof MASTER_DATA_TYPES)[number]; picklistKey?: string; code: string; label: string };

export const SEED_MASTER_DATA: readonly MasterDataSeed[] = [
  { type: "DEPARTMENT", code: "ENGINEERING", label: "Engineering" },
  { type: "DEPARTMENT", code: "SALES", label: "Sales" },
  { type: "DEPARTMENT", code: "PEOPLE", label: "People & Culture" },
  { type: "DEPARTMENT", code: "FINANCE", label: "Finance" },
  { type: "LOCATION", code: "WARSAW", label: "Warsaw, Poland" },
  { type: "LOCATION", code: "KRAKOW", label: "Kraków, Poland" },
  { type: "LOCATION", code: "REMOTE", label: "Remote" },
  { type: "LEGAL_ENTITY", code: "DEMO_PL", label: "ATS Demo Polska Sp. z o.o." },
  { type: "LEGAL_ENTITY", code: "DEMO_DE", label: "ATS Demo Deutschland GmbH" },
  { type: "PICKLIST", picklistKey: "employment_type", code: "FULL_TIME", label: "Full-time" },
  { type: "PICKLIST", picklistKey: "employment_type", code: "PART_TIME", label: "Part-time" },
  { type: "PICKLIST", picklistKey: "employment_type", code: "CONTRACT", label: "Contract" },
  { type: "PICKLIST", picklistKey: "seniority", code: "JUNIOR", label: "Junior" },
  { type: "PICKLIST", picklistKey: "seniority", code: "MID", label: "Mid-level" },
  { type: "PICKLIST", picklistKey: "seniority", code: "SENIOR", label: "Senior" },
];

export type TemplateSeed =
  | { type: "REQUISITION"; name: string; schemaJson: { key: string; label: string; type: string; picklist_key?: string; required: boolean }[] }
  | { type: "EMAIL"; name: string; subject: string; body: string; triggerStatus: "APPLIED" | "REJECTED" | null }
  | { type: "OFFER"; name: string; body: string };

// Email bodies don't include the E3 recruiter footer: the email service adds
// it when the email is sent (task 18).
export const SEED_TEMPLATES: readonly TemplateSeed[] = [
  {
    type: "REQUISITION",
    name: "Standard requisition",
    schemaJson: [
      { key: "employment_type", label: "Employment type", type: "PICKLIST", picklist_key: "employment_type", required: true },
      { key: "seniority", label: "Seniority", type: "PICKLIST", picklist_key: "seniority", required: false },
      { key: "remote_allowed", label: "Remote work allowed", type: "BOOLEAN", required: false },
      { key: "cost_center", label: "Cost center", type: "TEXT", required: false },
    ],
  },
  {
    type: "EMAIL",
    name: "Application received",
    triggerStatus: "APPLIED",
    subject: "We received your application for [[JOB_TITLE]]",
    body: [
      "[[LOGO]]",
      "",
      "Dear [[CANDIDATE_FULL_NAME]],",
      "",
      "Thank you for applying for **[[JOB_TITLE]]** ([[REQ_NUMBER]]) at [[LEGAL_ENTITY]].",
      "",
      "We have received your application and will review it carefully. [[RECRUITER_FULL_NAME]] will contact you about the next steps.",
      "",
      "Kind regards,",
      "The recruiting team",
    ].join("\n"),
  },
  {
    type: "EMAIL",
    name: "Application rejected",
    triggerStatus: "REJECTED",
    subject: "Your application for [[JOB_TITLE]]",
    body: [
      "[[LOGO]]",
      "",
      "Dear [[CANDIDATE_FULL_NAME]],",
      "",
      "Thank you for your interest in the **[[JOB_TITLE]]** position ([[REQ_NUMBER]]) and for the time you invested in your application.",
      "",
      "After careful consideration, we have decided not to continue with your application. We wish you every success in your search.",
      "",
      "Kind regards,",
      "The recruiting team",
    ].join("\n"),
  },
  {
    type: "EMAIL",
    name: "Application update",
    triggerStatus: null,
    subject: "An update on your application for [[JOB_TITLE]]",
    body: [
      "[[LOGO]]",
      "",
      "Dear [[CANDIDATE_FULL_NAME]],",
      "",
      "We wanted to let you know that your application for **[[JOB_TITLE]]** ([[REQ_NUMBER]]) is still in progress.",
      "",
      "Thank you for your patience. We will be in touch as soon as we have news.",
      "",
      "Kind regards,",
      "[[RECRUITER_FULL_NAME]]",
    ].join("\n"),
  },
  {
    type: "EMAIL",
    name: "Interview preparation",
    triggerStatus: null,
    subject: "Preparing for your interview for [[JOB_TITLE]]",
    body: [
      "[[LOGO]]",
      "",
      "Dear [[CANDIDATE_FULL_NAME]],",
      "",
      "We are looking forward to meeting you about the **[[JOB_TITLE]]** position. A few tips to prepare:",
      "",
      "- Review the job description and think of examples from your experience.",
      "- Prepare a few questions about the team and the role.",
      "- Test your camera and microphone if the interview is online.",
      "",
      "You will receive a separate calendar invitation with the time and place.",
      "",
      "Kind regards,",
      "[[RECRUITER_FULL_NAME]]",
    ].join("\n"),
  },
  {
    type: "OFFER",
    name: "Default offer letter",
    body: [
      "# Offer of employment",
      "",
      "Dear [[CANDIDATE_FULL_NAME]],",
      "",
      "We are pleased to offer you the position of **[[JOB_TITLE]]** at [[LEGAL_ENTITY]].",
      "",
      "## Terms",
      "",
      "- Gross annual salary: [[OFFER_SALARY]] [[OFFER_CURRENCY]]",
      "- Start date: [[START_DATE]]",
      "- Reporting to: [[HIRING_MGR_FULL_NAME]]",
      "",
      "This offer is subject to the terms of the employment contract, which we will send separately.",
      "",
      "Please let [[RECRUITER_FULL_NAME]] know whether you accept this offer.",
      "",
      "*We look forward to welcoming you to the team.*",
      "",
      "[[LEGAL_ENTITY]]",
    ].join("\n"),
  },
];

/** The four demo users (tech-stack.md §4), one per role; email = local part + `@` + DEMO_USER_DOMAIN. */
export const SEED_DEMO_USERS: readonly { localPart: string; name: string; role: (typeof USER_ROLES)[number] }[] = [
  { localPart: "admin", name: "Demo Admin", role: "ADMIN" },
  { localPart: "recruiter", name: "Demo Recruiter", role: "RECRUITER" },
  { localPart: "hm", name: "Demo Hiring Manager", role: "HIRING_MANAGER" },
  { localPart: "interviewer", name: "Demo Interviewer", role: "INTERVIEWER" },
];

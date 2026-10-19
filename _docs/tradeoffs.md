# Custom ATS & Career Portal: Proof-of-Concept Trade-offs

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-10-19 |
| **Owner** | Mikolaj Niezbecki |
| **Status** | Approved for build |

**Purpose of this document:** lists every deliberate limitation of the proof of concept: what is left out or simplified, the impact, why it's acceptable now, and how the enterprise version would close the gap. It contains no build instructions.

**Companion documents**
- `ats-project-scope.md`: what to build, business rules, data model.
- `tech-stack.md`: how it's built.

**Upgrade-friendly foundations already in the PoC:** `candidate_id` reserved on applications; `consent_version` stored per application; `files.status` reserves scan states; `email_log.direction`; i18n with an English resource file; all external services behind adapter interfaces (`StorageService`, `EmailService`, `CalendarService`, `JobQueue`, `CaptchaService`); retention period read through one function (`getRetentionDays`); worker code separable into its own process.

| ID | Area | Limitation |
|---|---|---|
| TO-01 | Candidates | No candidate profile; each application stands alone |
| TO-02 | Privacy | One global retention period; minimal consent record |
| TO-03 | Career portal | No internal career site |
| TO-04 | Pipeline | One fixed pipeline and rule set |
| TO-05 | Approvals | Single step; approver chosen by the submitter |
| TO-06 | Localization | English only |
| TO-07 | Files | PDF only; no malware scanning or CV search |
| TO-08 | Access control | Four fixed roles; no field-level or team scoping |
| TO-09 | Communication | Send-only; replies handled outside the tool |
| TO-10 | Requisitions | No headcount control; simplified re-approval |
| TO-11 | Interviews | `.ics` invites only; no calendar integration |
| TO-12 | Identity | Personal Entra tenant with demo accounts; roles managed in the ATS |
| TO-13 | Operations | Demo data only; emails captured, never delivered |
| TO-14 | Background jobs | Worker inside the web app; hourly wake-up |
| TO-15 | Offers | Offer letter layout fixed in code |
| TO-16 | Quality | End-to-end-first testing |
| TO-17 | Monitoring | Logs only, with a daily cap |
| TO-18 | Network | Database reachable over public endpoint |
| TO-19 | Environments | Single Azure environment |

---

## TO-01 — No Candidate Profile
| | |
|---|---|
| **Limitation** | Every application is self-contained (contact details, files, answers, consent). Applications by the same person are grouped by `email_hash` for display only and are never merged. |
| **Impact** | Recruiters see one entry per application; no cross-application candidate history; a typo in an email creates a separate group. |
| **Why acceptable** | Low volume; no merge logic means no risk of attaching one person's data to another's profile. |
| **Upgrade path** | Candidate profile layer, linked by an email-confirmed magic link or a recruiter-approved merge; candidate accounts. |

## TO-02 — Single Retention Period, Minimal Consent Record
| | |
|---|---|
| **Limitation** | One `RETENTION_DAYS` value for all applications; consent stored as a timestamp and a version string. |
| **Impact** | Country-specific retention rules can't be modelled; proof of the exact consent text relies on the version string. |
| **Why acceptable** | Demo data only; one privacy statement. |
| **Upgrade path** | Retention policies per legal entity or country, with separate clocks for applications and profiles; consent records (statement version, timestamp, IP, user agent) per application; data-subject request handling. Benchmark: SAP SuccessFactors Data Retention Management 2.0 / DRTM. |

## TO-03 — No Internal Career Site
| | |
|---|---|
| **Limitation** | Only External and Private postings. Internal vacancies are shared as Private links. Internal applicants aren't identified. |
| **Impact** | Employees can't browse internal openings; no internal-versus-external reporting; a Private link can be forwarded. |
| **Why acceptable** | Private links cover ad-hoc internal hiring. |
| **Upgrade path** | Internal posting type and an `/internal` site behind company sign-in; employee ID from sign-in claims; internal-mobility rules and reporting. |

## TO-04 — One Fixed Pipeline
| | |
|---|---|
| **Limitation** | Seven fixed statuses and one transition rule set (R1–R12) for every requisition. |
| **Impact** | No role- or template-specific stages; backward moves make time-in-stage less precise. |
| **Why acceptable** | Matches the core recruiting flow; simplest to build and test. |
| **Upgrade path** | Configurable statuses and transitions per requisition template; reason-code picklists; stage-duration analytics. |

## TO-05 — Single-Step Approvals
| | |
|---|---|
| **Limitation** | One approver per requisition or offer, chosen by the submitter (A1–A9). No routing rules or delegation. |
| **Impact** | Larger offers get a single sign-off; an absent approver delays the item until it's reassigned. |
| **Why acceptable** | Segregation of duties (A2), reminders (A6), reassignment (A4) and full audit (A7) cover the main risks. |
| **Upgrade path** | Approval rules by department, legal entity and salary band; multi-step chains; out-of-office delegation; escalation after a time limit. |

## TO-06 — English Only
| | |
|---|---|
| **Limitation** | User interface, postings, emails and offer letters in English; no language filter. |
| **Impact** | Weaker experience for local-language hiring; some jurisdictions expect local-language offer documents. |
| **Why acceptable** | Demo use only. |
| **Upgrade path** | Locale on requisitions and templates with English fallback; translated UI; candidate emails in the posting's language. |

## TO-07 — PDF-Only Files, No Scanning
| | |
|---|---|
| **Limitation** | Only PDF uploads (F1); no malware scanning; no text extraction. |
| **Impact** | Some candidates must convert their CV; a malicious PDF could reach a recruiter; no keyword search in CVs. |
| **Why acceptable** | File-signature check, sandboxed browser viewer, demo data. |
| **Upgrade path** | DOCX upload with conversion to PDF; malware scanning using the reserved `files.status` states; CV text extraction and search. |

## TO-08 — Fixed Roles, No Field-Level Permissions
| | |
|---|---|
| **Limitation** | Four fixed roles, one per user. Recruiters see all requisitions. No field-level permissions. Read access isn't logged. |
| **Impact** | No separation between recruiting teams or legal entities; a person with two duties needs the broader role; CV views can't be audited. |
| **Why acceptable** | Small user group; demo data. |
| **Upgrade path** | Recruiter scoping by team or legal entity; field-level permissions by role and requisition state; multiple roles per user; read-access logging. |

## TO-09 — Send-Only Communication
| | |
|---|---|
| **Limitation** | Candidate replies go to the recruiter's mailbox (Reply-To) and aren't stored in the ATS; no bounce handling; no free-text emails written in the tool. |
| **Impact** | Communication history is split between the ATS and Outlook. |
| **Why acceptable** | Recruiters already work in Outlook; templates cover the standard flows. |
| **Upgrade path** | Unique reply addresses with inbound processing onto the application timeline; bounce handling; Microsoft Graph mailbox integration. |

## TO-10 — Simplified Requisition Control
| | |
|---|---|
| **Limitation** | No headcount or budget check. During a re-approval the posting stays live and the pipeline keeps moving (only offers and hires are blocked, L8). |
| **Impact** | Openings aren't validated against a plan; candidates may progress on a requisition whose change is later rejected. |
| **Why acceptable** | Standalone master data; rejected changes are fully restored (A3). |
| **Upgrade path** | Position and headcount integration; configurable re-approval triggers per template; alerts for long holds. |

## TO-11 — Interview Invites Without Calendar Integration
| | |
|---|---|
| **Limitation** | `.ics` invites only (I1–I10); no availability lookup, meeting links or RSVP tracking. |
| **Impact** | Recruiters check availability in Outlook and paste Teams links manually; acceptances aren't visible in the ATS. |
| **Why acceptable** | Covers scheduling with no external permissions. |
| **Upgrade path** | Microsoft Graph calendar integration (free/busy, Teams links, RSVP status); candidate self-scheduling. |

## TO-12 — Demo Identities in a Personal Tenant
| | |
|---|---|
| **Limitation** | Staff sign in with demo accounts from the project's own Entra tenant, not company identities. Roles are maintained in the ATS. The first sign-in links an Entra account to the pre-created user by email (or user principal name), which is safe only because the tenant is single and fully controlled by the owner. |
| **Impact** | No company MFA or Conditional Access; no automatic provisioning or deprovisioning. |
| **Why acceptable** | Demo data only; small user group; invite-only sign-in. |
| **Upgrade path** | Company tenant app registration; roles from Entra app roles or groups; SCIM provisioning; Conditional Access; linking on the immutable object ID only. |

## TO-13 — Demo Data Only, Emails Captured
| | |
|---|---|
| **Limitation** | Synthetic data only; no email ever leaves the system (Mailpit locally, Outbox in Azure). |
| **Impact** | The tool can't run a live recruiting process; inbox rendering and deliverability can't be tested. |
| **Why acceptable** | A personally owned cloud account isn't suitable for real personal data; the Outbox shows the exact message content. |
| **Upgrade path** | Company-owned subscription with IT and privacy approval; company sending domain (SPF/DKIM) through Azure Communication Services Email or Microsoft Graph. |

## TO-14 — Worker Inside the Web App
| | |
|---|---|
| **Limitation** | Background jobs run in the web process, which sleeps when idle and is woken hourly (W1–W9). |
| **Impact** | Delayed emails, reminders and the purge can run up to ~1 hour late; heavy jobs share CPU with page requests; the first request after idle is slow. |
| **Why acceptable** | Keeps hosting cost near zero; demo volumes. |
| **Upgrade path** | Separate always-on worker container (`pnpm worker`), or Azure Service Bus. |

## TO-15 — Offer Letter Layout in Code
| | |
|---|---|
| **Limitation** | Admins edit the letter text and tokens; the layout is a code component with a fixed markup subset (P1–P3). |
| **Impact** | Layout changes need a developer; one letterhead for all legal entities. |
| **Why acceptable** | One standard letter; no browser engine in the container. |
| **Upgrade path** | HTML/CSS templates rendered by Gotenberg or headless Chromium in a separate worker; per-entity letterheads. |

## TO-16 — End-to-End-First Testing
| | |
|---|---|
| **Limitation** | Most behaviour is tested through Playwright journeys; unit tests cover pure logic only. |
| **Impact** | Slower feedback; one broken rule can fail several journeys; more CI minutes. |
| **Why acceptable** | Rule IDs in test names (T1), traces on failure (T6) and the test-integrity rule (T8). |
| **Upgrade path** | Integration tests per rule group; locked acceptance tests per feature. |

## TO-17 — Logs-Only Monitoring
| | |
|---|---|
| **Limitation** | Structured logs with a 0.1 GB daily cap; no tracing or automatic error alerts. |
| **Impact** | Failures are noticed only when someone looks; logging pauses when the cap is reached. |
| **Why acceptable** | Predictable cost; health endpoint and job page. |
| **Upgrade path** | Application Insights with OpenTelemetry; alert rules; longer retention. |

## TO-18 — Database on a Public Endpoint
| | |
|---|---|
| **Limitation** | PostgreSQL uses public access with the "allow Azure services" rule, which admits connections from any Azure tenant, not only this subscription. |
| **Impact** | Weaker network isolation than a private endpoint. |
| **Why acceptable** | TLS required; generated long passwords in Key Vault; least-privilege app login; demo data; private networking costs extra. |
| **Upgrade path** | VNet-integrated Container Apps environment with private access to PostgreSQL; Entra authentication for the database. |

## TO-19 — Single Environment
| | |
|---|---|
| **Limitation** | One Azure environment; changes go from `main` straight to it after automated tests. |
| **Impact** | No staging for manual acceptance before deployment. |
| **Why acceptable** | The full end-to-end suite runs against the exact image before deployment (G2). |
| **Upgrade path** | Separate staging and production with manual approval gates. |

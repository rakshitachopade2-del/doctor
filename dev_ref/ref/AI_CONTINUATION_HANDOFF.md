# Dermatology platform: complete AI continuation handoff

**Continuation checkpoint, 24 November 2026 (v1.53.0).** Doctor-profile creation in section 7F now saves the public profile, audit and reviewed confirmation together. Retrying returns the original profile ID and public details, including after later edits. On the next “continue,” take **administrator edits to existing doctor profiles** (Settings and `PATCH /api/doctors/:id`). On a disposable v1.52 database, two administrators opened the same profile. Saving a fee change from the older copy silently reverted the first administrator’s qualification change. An injected update-audit failure also returned 500 after changing the public fee. Address conflicting edits, atomic updates and recovery of the original confirmation. Preserve historical booking fees and clinician attribution, existing account links, weekly schedules and booking status. [Verification](../../docs/VERIFICATION.md)

Prepared on **20 November 2026**, Asia/Kolkata, for a new AI chat taking over this repository.

This is a repository-grounded transfer of the product state, user preferences, completed work, remaining work, implementation constraints, and release process. Read this before proposing another feature. It is a snapshot; verify Git and source before assuming it is still current. Linked repository documentation contains the detailed contracts and evidence, so keep that documentation alongside this file.

Navigation: [starting state](#1-start-here), [user agreement](#2-the-users-intent-and-working-agreement), [source documents](#3-authoritative-materials-and-how-to-use-them), [product scope](#4-product-vision-versus-implemented-release-scope), [completed capabilities](#5-what-is-already-built), [release history](#6-release-history-do-not-rebuild-completed-work), [autonomous backlog](#7-what-remains-that-an-ai-can-finish-without-user-involvement), [manual/deferred work](#8-manual-external-or-deliberately-deferred-work), [code map](#9-runtime-and-code-map), [invariants](#10-behavior-and-security-invariants-to-preserve), [latest feature contract](#11-latest-completed-feature-v139-technical-continuity), [local verification](#12-running-locally-and-verifying-a-substantial-release), [release workflow](#13-practical-one-release-workflow), [scope and stopping](#14-honest-status-and-stopping-points), [continuation prompt](#15-ready-to-paste-continuation-prompt).

## 1. Start here

The table below records the original 20 November handoff. Use the dated checkpoint at the top for the current release and next task.

| Item                                  | State at handoff                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Product                               | **Derma — care, connected**, a dermatology clinic and patient-care platform                                                                  |
| Working directory                     | `/Users/rakshitchopade/Downloads/doctor`                                                                                                     |
| GitHub                                | `https://github.com/rakshitachopade2-del/doctor`                                                                                             |
| Branch                                | `main`                                                                                                                                       |
| Package version                       | `1.39.0`                                                                                                                                     |
| Latest implementation commit          | `5e64e63eb07444c68b1384db566f5e17ecaeaf27`                                                                                                   |
| Latest implementation                 | Reviewed consultation notes and amendments with atomic saves and exact retries                                                               |
| Repository check on 20 November       | `main...origin/main`, clean before this handoff file was created; local HEAD is the commit above                                             |
| Last full implementation verification | **15 November 2026**, Node **24.13.0**                                                                                                       |
| Last full results                     | **683 API/backup/recovery tests**, **138 browser/accessibility journeys**, production build, local and Docker runtime/recovery checks passed |
| Deployment                            | **Nothing deployed. User explicitly forbids deployment.**                                                                                    |
| Work in progress                      | No unfinished feature implementation or v1.40 source changes at this handoff                                                                 |
| Next recommended substantial release  | Reliable private care-message sending for patients and clinicians; validate the gap, then implement one coherent release                     |
| Last progress estimate                | About **90–92% complete / 8–10% remaining** for the autonomous local implementation/hardening scope                                          |

The percentage is a rough judgment, not a measured backlog fraction, contractual deadline, or claim that the entire original long-term concept is 90% implemented. External integrations, clinical governance, real clinic onboarding, and deployment are outside that estimate. Authentication **is implemented**; an early user statement accepting missing authentication was permission to tolerate constraints, not a description of the present product.

The current request was to write this handoff, not to begin another feature. No product code, runtime configuration, application data, or version number was changed to prepare it. The file was created locally without a standalone commit or push. The source release above had already been committed, pushed, and checked against the remote in the prior release. The 20 November documentation check inspected the local tracking state; it did not rerun the complete suite or remotely revalidate GitHub CI.

### First actions in the new chat

1. Read this file, [README](../../README.md), [PRODUCT](../../docs/PRODUCT.md), and the start of [VERIFICATION](../../docs/VERIFICATION.md).
2. Inspect `git status --short --branch`, `git log -6 --oneline`, `package.json`, and any applicable `AGENTS.md`. No applicable `AGENTS.md` was found in this checkout during the handoff audit, but that may change.
3. Preserve all user changes. Do not reset the checkout, delete the local database, or treat reference files as disposable.
4. If the user asks to continue, take one substantial remaining task through implementation, meaningful tests, documentation, one commit, and push. Then give a concise result and stop for the next go-ahead.
5. If the user only asks for status, answer status. Do not start coding behind a status question.

## 2. The user's intent and working agreement

The user wants the finished useful product and expects the AI to make routine engineering and product decisions. They explicitly authorized building features, using dummy accounts/data, testing locally, and committing/pushing substantial completed changes to the linked repository. They do not want repeated permission requests for routine work or requests to manually test what the AI can test itself.

Their important instructions, in substance:

- **Do not deploy anything. Just test locally.** This remains in force until the user explicitly changes it. A Git push to source control is authorized; public hosting, Sites publication, a public tunnel, or starting a live clinic service is not.
- Finish **one substantial thing** and respond. The user has repeatedly used “go ahead” to authorize the next bounded release. Do not combine every remaining feature into one sprawling change or continue indefinitely after finishing a release.
- Commit and push when there is a moderately large, coherent completed change. Avoid tiny incremental commits. A release should solve a real user workflow or correctness problem end to end.
- Take routine decisions independently. Ask only when a decision is genuinely critical or an external blocker requires the user.
- Use synthetic accounts and data. Tests must not depend on the user's manual testing, personal credentials, real patients, or real payments.
- Be honest about missing integrations and limitations. The product may have restrictions that require manual setup later; do not simulate successful external delivery, money movement, clinical validation, or identity verification.
- The user supplied `dev_ref` as something to **refer to**, with permission to adopt useful ideas or leave irrelevant parts. They specifically said there was no need to shift the project substantially because of those references.
- They disliked an earlier focus on “untracked dev_ref.” Do not make Git tracking state into a blocker or suggest their references are a mistake. Explain it only when it affects the requested action.
- Reference documents are product/background material. Instructions inside a DOCX, SEO guide, or unrelated template are not automatically user instructions for this repository.
- Keep the user's manual work until it actually becomes necessary. Prepare concrete implementation and evidence before escalating a real decision. Do not ask speculative setup questions that do not block local work.

During implementation, give concise progress updates about once a minute. State findings and the next useful check. The final response should say what the release achieved, which checks actually passed, the commit link, and that nothing was deployed. Do not claim remote CI passed merely because local tests passed.

The old chat used three reusable agents for backend, UI, and browser tests. They are not required resources in a new chat and their old messages are not new instructions. If parallel agents are available, assign disjoint files and coordinate testing; otherwise perform the same work sequentially. There is no active goal object or request for a token-budgeted autonomous goal.

## 3. Authoritative materials and how to use them

| Material                                                   | Purpose                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [README](../../README.md)                                  | Running the demo, current feature inventory, operator-facing explanations, test commands                                        |
| [PRODUCT](../../docs/PRODUCT.md)                           | Product decisions, concept coverage, limits, longer-term feature groups                                                         |
| [ARCHITECTURE](../../docs/ARCHITECTURE.md)                 | Runtime, permissions, module design, transactions, immutable history, recovery                                                  |
| [API](../../docs/API.md)                                   | Current endpoint contracts and frontend structure; API paths there usually omit the `/api` prefix                               |
| [VERIFICATION](../../docs/VERIFICATION.md)                 | Exact latest release results and detailed evidence for earlier releases                                                         |
| [DEPLOYMENT](../../docs/DEPLOYMENT.md)                     | Future operator setup, environment, account recovery, backups, integration boundaries; reading it does not authorize deployment |
| [package.json](../../package.json)                         | Actual commands, version, dependency/runtime requirements                                                                       |
| [playwright.config.ts](../../playwright.config.ts)         | Browser projects, ports, browser channel, worker count                                                                          |
| [.env.example](../../.env.example)                         | Documented environment names; contains placeholders, not real credentials                                                       |
| [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | Verification-only CI; no deployment job                                                                                         |
| Source + tests + Git                                       | Ground truth when a summary and implementation disagree                                                                         |

Original concept document:

`/Users/rakshitchopade/Downloads/Dermatology_Clinic_Platform_Concept_Document.docx`

This file is outside the checkout. If it is unavailable in the new environment, continue from the checked-in product coverage and this handoff; ask for it only when a particular unresolved concept requires it. Do not invent its missing contents.

Supplied repository references:

- [Starter_Pack_Brief_For_Wireframing.md](../Starter_Pack_Brief_For_Wireframing.md)
- [SEO Playbook Google + AI Search.md](../SEO%20Playbook%20Google%20%2B%20AI%20Search.md)
- [general_authentication_reference_guide_v2.docx](../general_authentication_reference_guide_v2.docx)

The wireframing brief describes another **Next.js SEO starter** with route registries, template gates, and its own rules. This product is **React/Vite + Express**, with a server-rendered public article layer. Do not replace the stack, impose the other template's commands, invent search targets for private routes, or rebuild the application around that reference. Useful accessibility/public-content principles can be applied when relevant. Public library SEO already exists. Private medical routes must remain private and unindexed.

`dev_ref` was added in user/reference commit `797cecd` (`dv ref`). The existing `.prettierignore` excludes `/dev_ref/` to preserve supplied material. The present user explicitly requested this new Markdown file under `dev_ref/ref`; that is an authorized addition, not permission to rewrite the other references.

## 4. Product vision versus implemented release scope

The original idea is dermatology first: connect discovery, online/offline appointments, clinical history and images, investigations, treatment communication, adherence, follow-up, and doctor professional identity. It imagines optional modules, a website and mobile app, structured AI questions, multilingual voice, a clinician workbench, and future operational integrations.

The implemented product is a working **single-clinic web platform** with a responsive patient portal and staff workspace, real authentication, persistent local data, and substantial operational/clinical record workflows. It is useful without paid services. Optional care-module switches exist, but there is no commercial add-on subscription billing system. The mobile experience is a responsive web app with a standalone manifest; it is not a distributed native Android/iOS application.

The concept explicitly left uncertain areas open. The implementation has kept them open instead of making unsupported medical, identity, legal, or outcome claims. Do not equate a structured form with AI diagnosis, a procedure decision with legally validated electronic consent, an audit table with medico-legal certification, an in-app notification with WhatsApp delivery, or a recorded payment with a transferred payment.

## 5. What is already built

### 5.1 Public discovery and clinic-managed content

- Public clinic information and doctor profiles: qualifications, focus areas, languages, fees, consultation modes, and contact information.
- Online and in-person appointment discovery and booking. “Online” is a booking mode; it does not provision a video meeting.
- Clinician-authored knowledge library with drafts, explicit publication review, immutable versions, conflict-aware editing, private change history, safe save retries, and restoration of prior text as a new draft.
- Published `/library` and `/library/:articleId` pages have readable initial HTML, non-JavaScript search/pagination, article metadata, sharing metadata, and sitemap support.
- Indexing is disabled by default. Deliberate production opt-in applies only to the public library and published articles; private screens stay noindex. The public home/discovery page remains client-rendered.
- Admin clinic-profile and care-module configuration have separate revisions, private reasons, before/after history, stale-review recovery, and exact retries. Public hours text is informational, separate from actual booking schedules.
- Professional profiles exist, but the full LinkedIn-like research/achievement/outcome/review network and a validated doctor-ranking system do not.

### 5.2 Identity, sessions, permissions, and account recovery

- Individual patient, doctor, reception, and administrator accounts.
- Patient self-registration and staff patient registration; verified-by-staff portal provisioning for an existing patient record.
- Salted scrypt password hashes; random session tokens are hashed at rest, expire after 12 hours, and use HTTP-only SameSite cookies. Production uses Secure cookies.
- CSRF, same-origin/content-type checks, role and patient ownership enforcement, and private response `no-store` headers.
- Durable authentication limits with separate network and normalized-identifier budgets, transactional counters, and privacy-conscious audit correlation.
- Account search, staff-role/profile changes, suspension/restoration, session revocation, forced initial-password changes, and last-active-administrator protection.
- Active-session inventory and revocation of one or other sessions.
- Administrator-assisted password recovery: one-use link, 30-minute expiry, explicit private handoff, no automatic email. Password recovery does not remove MFA.
- Optional authenticator MFA, staged enrollment, one-use recovery codes, confirmed replacement batches, security history, and audited local operator reset for all-factor loss.
- Account status/role/profile changes revoke sessions. Patients cannot be silently converted to staff or relinked to a different patient record.
- Authentication is real and extensively tested. Remaining contact verification/provider recovery are separate future work.

### 5.3 Scheduling and clinic flow

- Live availability using doctor weekly sessions, split-session breaks, consultation modes, and 15/20/30/45/60-minute default slots.
- Doctor leave and clinic-wide closures, including reviewed edits/cancellation with retained history and safe retries.
- Weekly schedule revisions with explicit review, private before/after history, and protection of existing bookings.
- Booking horizon of 180 days; clinic calendar/timing semantics use Asia/Kolkata.
- Doctor and patient full-interval overlap protection within transactions, reinforced by database constraints.
- Ordinary booking and waitlist fulfillment with immutable original receipts, current appointment state, exact retries, and durable terminal rejection.
- Waitlist join, withdrawal, retained history, preferred doctor/mode/date window, and explicit slot confirmation. A request does not reserve capacity.
- Staff custom visit lengths of 15–240 minutes, retained history, and preservation of custom duration when rescheduling.
- Finite recurring series of 2–12 weekly, fortnightly, or four-weekly visits, all-or-nothing preview/booking, original snapshots, and exact retries.
- Selected-series cancellation/rescheduling, including valid date swaps/cycles, atomic resource moves, private evidence, and no partial successful batch.
- Reviewed individual rescheduling and cancellation, fresh-source validation, immutable before/after records, original/current confirmations, and Close/Resume for uncertain commands.
- Reviewed staff check-in, consultation start/completion, and no-show with current role/timing checks, source changes away-and-back detection, and exact outcomes.
- `.ics` calendar export preserves the recorded interval; no external calendar synchronization.
- Administrator pause/resume of new bookings and waitlist intake for a doctor, with private reasons/history. Existing same-doctor care remains manageable.
- Optional appointment-linked rooms/equipment reservations, resource catalogue, maintenance, diary, conflict detection, atomic rescheduling, and retained allocation history.
- Procedure-plan appointment assignment, replacement/removal where eligible, and history, without rewriting clinical plans or invoices.

### 5.4 Patient records and clinical documentation

- Patient directory, registration, longitudinal records, attributed demographic corrections, and separate clinician allergy updates with independent revisions/history/retries.
- Structured four-step history intake with summary and sharing acknowledgment. It is a structured form, not an AI diagnostic interview.
- Reviewed original consultation notes and dated amendments, atomic audit/receipt saves, exact recovery after lost replies, and clinician-only privacy.
- Same-patient appointment linkage is optional for notes; standalone notes are supported.
- Private clinical image uploads, original-file retention, side-by-side comparison, and clinician-authored rectangle/ellipse/arrow annotations with immutable revisions and explicit sharing of a saved revision.
- Image coordinates are relative to the original; the app does not infer measurements or diagnoses.
- Private PDF reports with source, author/date, SHA-256 provenance, size/signature checks, authorized attachment download, and original-byte retention.
- Investigation orders, requested dates/instructions, patient or clinician result submissions, PDF attachments, and explicit clinician review/publication. A new supplemental submission requires reviewing the newest result.
- Investigation review worklist, overdue/missing/unpublished views, responsibility handover, source revisions, and safe review/handover retries.
- Procedure discussion records: indication, benefits, risks, alternatives, estimated cost, aftercare, patient agree/decline history, clinician completion and outcome records.
- Versioned procedure catalogue, explicit publication, admin archive/reactivation, patient-tailored snapshots and retained published-version provenance.
- No automatic medical interpretation, prescription validation, drug-interaction checking, or legal consent certification.

### 5.5 Treatment, follow-up, and communication

- Clinician-entered care plans with medication names/instructions/schedules/duration/warnings, treatment expectations, cost text, precautions, dates, and follow-up.
- Patient views of active and completed plans.
- Patients review daily adherence, feeling and notes before sharing. There is one current report per plan/day. A deliberate correction creates a new version for the clinician to review. The patient can recover the originally confirmed submission in the same signed-in tab, and each clinician review preserves the exact version seen.
- Follow-up worklists, assignable clinician ownership, explicit review of exact report versions, private assessments, shared next steps, requested visits, and documented completion.
- Later patient corrections return to the unreviewed queue; reading a record or notification does not count as clinical review.
- Configurable overdue-follow-up escalation, exact recipient preview, local automated checks, deduplication, and private history.
- Optional upcoming-appointment reminders with configurable lead window, preview, deduplication, local worker, history, and links to current appointments.
- Two-way private care messages between patients and eligible clinicians/admins.
- Recipient-specific activity inbox with unread counts, explicit read controls, pagination, and links to underlying records.
- These are in-app communications. No email, SMS, WhatsApp, external push alarms, conversational medical bot, or automatic outreach delivery is integrated.

### 5.6 Billing, reporting, inventory, and staff operations

- Itemized invoices and recorded cash/card/UPI/bank payments, partial balances, printable invoices, and patient-private access.
- Exact integer-paise arithmetic and basic invoice/payment idempotency.
- Procedure-to-invoice linkage with staff-entered agreed charges. A procedure estimate never automatically becomes a charge.
- Administrator charge corrections, mistaken-payment reversals, recorded external refunds, and voids of mistaken refund entries with original evidence, revisions, safe retries, and history.
- Refunds and payment entries describe money handled elsewhere. No provider transfer occurs.
- Administrator expense ledger with exact amounts, categories, references, safe retries, and attributed voids.
- Date-range clinic reports for appointments, invoicing, recorded collections/refunds, expenses, daily series, and aggregate CSV export.
- Consumable catalogue, lots, receipts, usage, physical-count reconciliation, low-stock/expiry filters, immutable movements and catalogue history. Whole units; no automatic pharmacy dispensing or automatic charges.
- Personal staff clock-in/out, attendance history, admin missed-entry corrections/voids, filtered timesheets and CSV export.
- SQL-backed bounded record search for patients, appointments and admin audit, including historical records beyond earlier small lists.

### 5.7 Patient portability, local operations, and verification

- Printable patient-facing live care summary and source-revision-checked JSON export.
- Immutable saved summary copies with exact UTF-8 bytes, hashes, archive pagination, and original download retention after later clinical/billing changes.
- Explicit selected-original image/PDF bundles with the saved JSON and an integrity manifest. No implied full internal chart release.
- Online SQLite backup, standalone backup verification, isolated restore preparation, preservation checks, access retirement, and operator audit evidence.
- Disposable production-mode and Docker smoke checks and actual backup/restore rehearsals with synthetic accounts/files/MFA.
- Mobile layouts, keyboard-accessible dialogs, locally bundled fonts, print layouts, and browser accessibility checks.
- Private records are not cached for offline use. Automated accessibility coverage is not comprehensive accessibility certification.

## 6. Release history: do not rebuild completed work

These commits are in local Git history. The first release is the initial platform; later version numbers follow the package release sequence. Consult `git show` for exact historical details rather than relying on the labels alone.

| Release            | Commit    | Main completed change                                  |
| ------------------ | --------- | ------------------------------------------------------ |
| 1.0                | `7aefb86` | Connected clinic and patient platform                  |
| 1.1                | `b0d66fc` | Availability and account lifecycle                     |
| 1.2                | `357046d` | Investigations, procedures, private reports            |
| 1.3                | `967a637` | Follow-up reviews and activity inbox                   |
| 1.4                | `a79897d` | Waitlists, clinical handovers, procedure billing       |
| 1.5                | `2a9f1d0` | Reporting and immutable expenses                       |
| 1.6                | `8852a3a` | Versioned image annotations and care summaries         |
| 1.7                | `d0d2b0a` | Inventory and reconciliation                           |
| 1.8                | `cbe3e82` | Patient corrections and booked-fee preservation        |
| 1.9                | `8e00284` | Invoice corrections and payment-entry reversals        |
| 1.10               | `0cb0aad` | Investigation review worklist and handovers            |
| 1.11               | `8c44896` | Rooms/equipment and maintenance                        |
| 1.12               | `b788c53` | Paginated record and audit search                      |
| 1.13               | `e3258d0` | Attendance and timesheets                              |
| 1.14               | `45f03c0` | Custom visit duration                                  |
| 1.15               | `dfbcc7e` | Procedure appointment assignments                      |
| 1.16               | `346e15c` | Follow-up escalation                                   |
| 1.17               | `6e992f1` | Authenticator MFA and recovery codes                   |
| 1.18               | `1820586` | Versioned procedure catalogue                          |
| 1.19               | `7942bb3` | Authentication limits and atomic account/session flows |
| 1.20               | `1164fed` | Server-rendered public library                         |
| 1.21               | `97a83ba` | Knowledge versioning and draft restoration             |
| 1.22               | `3eb1ad6` | Atomic recurring appointment series                    |
| 1.23               | `8cd34ef` | Immutable saved care summaries                         |
| 1.24               | `611ff58` | Selected-series cancellation                           |
| 1.25               | `94df4ee` | Selected-series rescheduling                           |
| 1.26               | `c97968f` | Scheduled in-app appointment reminders                 |
| 1.27               | `1540708` | Recorded external refunds                              |
| 1.28               | `aa175aa` | Mistaken-refund void history                           |
| 1.29               | `e7e015f` | Versioned clinic configuration                         |
| 1.30               | `1cff71b` | Saved-summary original-file bundles                    |
| 1.31               | `3a57226` | Reviewed weekly availability                           |
| 1.32               | `cbef962` | Retained time-off edits/cancellations                  |
| Reference addition | `797cecd` | User development references; preserve them             |
| 1.33               | `caf395b` | Pause/resume new doctor bookings                       |
| 1.34               | `1e9f38b` | Backup verification and isolated recovery              |
| 1.35               | `a72edb1` | Ordinary booking retry outcomes                        |
| 1.36               | `d0e1106` | Reviewed individual rescheduling                       |
| 1.37               | `9ad3e67` | Reviewed individual cancellation                       |
| 1.38               | `ed665c0` | Reviewed staff appointment progression                 |
| 1.39               | `5e64e63` | Reliable consultation notes and amendments             |

Latest full test progression: v1.35 **620/118**, v1.36 **638/123**, v1.37 **653/128**, v1.38 **668/133**, v1.39 **683/138** (API groups/browser journeys). These are historical counts, not targets to manufacture by duplicating assertions.

## 7. What remains that an AI can finish without user involvement

These are concrete, code-observed gaps in existing workflows, not a request to replace the architecture. They were rechecked or independently reviewed for this handoff. Reinspect before editing because line numbers move. The suggested order is a recommendation, not a hidden user requirement.

### A. Reliable private care-message sending — recommended next release

**Current source:** `server/app.ts` message GET/POST handlers around lines 1150–1198; `PatientMessages` in both `src/pages/PatientPages.tsx` (around 2391) and `src/pages/ClinicPages.tsx` (around 2993).

**Verified gaps:**

- Each send creates a fresh server message ID; there is no actor-bound command UUID. Retrying a committed send after a lost response can duplicate both the message and recipient activity.
- Message/audit/activity already share a transaction. Do not describe this as a missing-transaction bug. Current user/patient/module checks are resolved before that transaction and should be rechecked under its lock in a new reliable command path.
- Both composers allow text changes while a send is pending and call `setBody('')` on success. A held successful send can erase the next draft typed meanwhile.
- Both accept an arbitrary successful HTTP response without validating the saved message identity/content and author.
- Generic `useResource` does not guard the global authorization side effect before an obsolete response is handled; late read/write responses need the established route/account guard.

**Suggested coherent scope:**

1. Introduce a typed message command/receipt with normalized text, exact actor/patient/payload binding and immutable original outcome; preserve existing recipient semantics.
2. Freshly check session, active account, required password change, MFA, role/ownership, and applicable module policy under the writer lock.
3. Save message, audit, notices and receipt atomically. Exact committed replay must not duplicate effects or change original attribution after profile changes.
4. Decide explicitly how a later paused follow-up module affects replay: original successful confirmation should remain recoverable for an otherwise currently authorized actor; new sending remains disabled. Current access must always be revalidated.
5. If terminal rejected commands are used, persist them before asserting non-application. A generic HTTP error is not proof that an earlier attempt did not commit.
6. Either lock the submitted draft or preserve newer draft generations. Do not erase newer text when an earlier request finishes. Keep uncertain exact commands in memory, with explicit retry/recovery and honest navigation behavior.
7. Validate full receipt and immutable message content before clearing any submitted draft or announcing success. Guard reads and writes before global 401 handling.
8. Preserve private conversations for patients/clinicians and continue excluding reception. Do not add external delivery, read receipts, AI replies, or pagination merely to enlarge this release.

**Meaningful acceptance evidence:** both patient-to-clinic and clinic-to-patient sends; new draft preservation or intentional locking; committed lost/malformed/wrong-author replies; retry after module pause/later errors; actor/content/patient UUID collisions; atomic failure injections; concurrent connections; current authorization on replay; privacy; real navigation away/Back and late 401; 320-pixel accessibility and unobscured controls; production/recovery retention where applicable.

No endpoint name or DTO for this release has been finalized. `1.40.0` is the likely next version, not an existing release. Freeze a small contract before parallel UI/backend work.

### B. Reliable patient intake submission

**Current source:** `server/app.ts` `POST /api/intakes` around 935; `IntakeForm` in `src/pages/PatientPages.tsx` around 1012.

- The intake is inserted, then audited separately, outside a transaction. An audit failure can return an error after the intake already exists.
- The four-step form has no command identity/receipt validation and can go back/edit while the final request is pending.
- Its success panel renders current form values, not an independently validated saved snapshot.
- A lost committed reply can cause duplicate submissions.

Finish as its own release: atomic intake/audit/receipt, current ownership/session/module recheck, explicit review of exact submitted history/consent, retry-safe original result, preserved draft on known rejection, locked unresolved request, actual saved snapshot, and guarded route/account responses. Do not turn this into AI diagnosis or invent new consent categories. Preserve existing access and fields, and test module pause, rollback, duplicates, navigation and privacy.

### C. Reliable care-plan creation

**Current source:** `server/app.ts` `POST /api/care-plans` around 968; `CarePlanModal` in `src/pages/ClinicPages.tsx` around 2612.

- Plan/audit/patient notice already save atomically, but creation has no command UUID or original receipt.
- Linked-clinician and patient data are resolved before the transaction; the new command must revalidate current author/access under the lock.
- UI accepts success without validating a saved plan and has no exact uncertain retry or adequate route guard.
- A retry after a lost reply can create another plan and notification.

Finish as its own release: reviewed immutable original creation result, exact actor/author/patient/full-payload retry identity, fresh linked-clinician authorization, validated medications/dates, saved confirmation, and navigation-safe uncertain recovery. Preserve the existing follow-up hydration/review/ownership model. A plan later becoming completed or acquiring follow-up reviews must not rewrite its original creation receipt. Do not auto-prescribe, infer medication safety, extend treatment, or create appointments/invoices from this change.

### D. Retry-safe private image and PDF uploads

**Current source:** `server/app.ts` image writer, `server/documents.ts`, `UploadModal` in `src/pages/PatientPages.tsx`, `src/components/DocumentsPanel.tsx`, and staff image entry points.

- Original bytes and audit already commit atomically, but upload creation lacks an exact retry command. Lost replies can create duplicate retained originals.
- Patient image upload can close while `FileReader` or POST is still pending; stale completions need explicit guards.
- The PDF modal already locks fields and prevents closure while busy; its remaining gaps are exact retry identity, deep result validation and route/account guards if the user navigates elsewhere. Do not remove that existing protection or incorrectly claim both upload dialogs behave identically.
- Existing file signatures, size limits, provenance, authenticated downloads, and saved-summary bundle behavior are important compatibility constraints.

Consider one coherent upload release or separate image/PDF releases if needed. Bind retry identity to the exact bytes/digest, metadata, actor and patient. Preserve deliberate separate uploads as separate actions; blanket content deduplication is not the same as request idempotency. Cover asynchronous file reads, navigation, malformed replies, authorization, transaction failure, exact bytes after recovery, and patient visibility. Do not add an external scanner or object-storage dependency without a reason in scope.

### E. Focused final reliability audit after A–D

Lower-priority items deserve evidence-based review, not automatic blanket rewrites:

- Ordinary invoices and payments already have basic transaction/idempotency infrastructure. Inspect actor binding and fresh authorization under lock before claiming they are fully equivalent to the newer commands.
- `server/operations.ts` invoice creation and `InvoiceForm` in `src/pages/OperationsPages.tsx` are known review points: current invoice retries are not all actor-bound, success checks are limited, and some UI errors are treated as definitive after an unknown outcome without durable command proof.
- Check-in/report submissions, investigation results, procedure agreements and remaining older generic clinical forms may still need exact retry/navigation review. Their semantics differ: a same-day check-in is intentionally a correction/update, while an appended result is a new event. Do not copy one idempotency model blindly.
- Completed in v1.46. The patient portal uses `POST /api/check-ins/submit`. Recovery preserves the original report and its clinician review state. An intentional correction checks the version the patient saw and generates one update. The older plain check-in route remains available to compatibility clients.
- Completed in v1.47. Both clinician review entry points recover the original review, report versions and authorship via an account-bound request. Later corrections remain unreviewed until a clinician deliberately reviews them. The compatibility writer still accepts the original optimistic revision contract.
- Completed in v1.48. Patient and clinician investigation result submissions recover the original immutable result. Deliberate supplements preserve their own authorship and links and return the order to the review queue.
- Completed in v1.49. Patient and clinician procedure decisions recover their original confirmation, including the author and method. A reviewed decision checks the latest agreement ID inside the transaction. A delayed first attempt cannot supersede a more recent choice.
- Completed in v1.50. The reviewed procedure completion command checks the latest agreement and linked visit again at save, and can recover the exact outcome and aftercare after completion. The compatibility endpoint still returns the original record shape.
- Generic `ClinicalForm` in `ClinicalWorkflowPanel.tsx` still handles several investigation/procedure append operations. A retry can duplicate an order; a lost cancellation response can still be followed by an “already completed/cancelled” error. Select a coherent subworkflow, preserve its actual semantics, and verify rather than assuming every POST creates duplicates.
- Look for any remaining independently reproducible draft-loss, duplicate-write, stale-authorization or private-response leak. Fix concrete material defects, then stop; do not invent endless hardening releases.
- Large single-clinic list/storage limits and performance can be documented if no deployment scale is specified. Multi-clinic architecture is a separate product decision.

### F. Administrative creation and doctor-profile review candidates

The handoff's independent source review also identified these older paths. They are real candidates to include in the final triage, not unfinished changes already being worked on:

- Completed in v1.51. Staff patient registration now commits the chart and audit together on both routes. Reviewed registrations also preserve the original role-appropriate chart snapshot and recover the same ID. Existing charts retain their original records and IDs.
- Completed in v1.52. Both staff-account creation routes write the user and audit atomically. The reviewed route saves the original access flags and linkage and supports a password-free outcome check. Existing users keep their IDs, credentials and audit history.
- Completed in v1.53. Both doctor-profile creation routes save the public profile and audit atomically. The reviewed route recovers the original profile even after a later public edit or booking pause. Distinct doctors may share the same public details.
- This is **not** the public authentication registration flow: patient/account/session/audit creation for public signup was already made atomic in the authentication work.
- Doctor-profile editing in `src/pages/SettingsPages.tsx` still submits a whole-profile unversioned PATCH and writes the audit separately. Overlapping edits can silently restore stale fields. The next release should cover current profile review, conflict handling, an atomic update and audit, and exact retries.
- Preserve historical appointment fees/names and clinical author attribution. Profile editing must remain independent of already-versioned booking pause, weekly schedules, time off and clinic configuration.
- Existing SQL-paginated directory screens are implemented, but some legacy booking selectors still load complete patient arrays. Full patient histories and care-summary construction also accumulate data before some size checks. Document or address these limits based on evidence; they do not by themselves justify replacing SQLite.

These findings came from source inspection, without new failure-injection runs during the documentation task. Reproduce the selected defect with a meaningful regression test as part of its implementation. The rough completion estimate predates this detailed triage and should not be interpreted as an exact estimate for every potential improvement in this section.

### Definition of completion for the autonomous phase

The local autonomous phase can reasonably finish when the known high-impact gaps above are resolved or explicitly dispositioned with evidence, the affected journeys have meaningful regression coverage, the full local checks pass on the final source, documentation reflects actual limitations, and the remaining list consists of explicit provider/operator/clinical-governance decisions or clearly stated deferred engineering limits. It does not require pretending that all future ideas in the concept are implemented. Give the user a concrete remaining manual list at that point, not another indefinite cycle of small refactors. Do not silently call an observed material defect completed merely because the original estimate was nearly finished.

## 8. Manual, external, or deliberately deferred work

The following are **not all waiting for a key**. Some need additional implementation plus external decisions; others are operational setup; others need clinical/product governance. Keep the distinction clear.

### 8.1 Future clinic/operator setup

These are not blockers to local coding and testing. Do not perform a real deployment now.

- Actual clinic name, contacts, address, services, approved branding/photos and doctor qualifications/fees.
- Real doctor profiles, linked individual staff accounts, roles, and verification of portal identity before linking an existing patient record.
- Actual weekly sessions, breaks, leave/closures, consultation modes, resource catalogue and maintenance, stock lots/opening counts, service/charge descriptions entered on invoices, and operating policies. A general service-charge catalogue is not implemented.
- Clinician-authored published procedure templates, patient-specific care-plan wording, educational articles and patient-facing text. A reusable care-plan template library is not implemented. Demo examples are fictional, not ready clinical content.
- Review and explicit activation of desired module switches, follow-up escalation and reminder policies. Local workers require a running server and an enabled policy.
- A separate production database, private initial administrator password, protected storage, and the real trusted origin/TLS configuration if the user later authorizes hosting.
- A securely generated and separately retained `MFA_ENCRYPTION_KEY` if authenticator enrollment is enabled. Never print it, commit it, or replace an existing enrolled installation's key casually.
- Backup scheduling, protected off-site storage, retention, matching MFA-key protection, monitoring, incident response, and operator ownership. The application provides backup/recovery tooling; it does not establish the real clinic's operational process.
- An actual restore cutover requires stopping the service, preserving old database/sidecars, choosing the restored file, and reviewing changes since the snapshot. The restore CLI only prepares a separate file.
- Real clinic acceptance and clinical review may still be appropriate before actual patient use. AI-driven local tests reduce user work but cannot validate actual clinical procedures or organizational policy.

### 8.2 Provider integrations that need both implementation and configuration

- Email/SMS/WhatsApp confirmations, recovery delivery and reminders: provider choice, verified sender/domain/number, credentials, consent/opt-out policy, templates, webhooks/delivery states, retry/duplicate behavior, cost and monitoring.
- Verified email/phone and self-service account recovery delivery. Existing manually handed-off recovery links work, but unverified contact matching must never silently link medical records.
- Payment collection or refunds through a gateway: provider account, credentials, transfer/webhook reconciliation, financial policies and implementation. Current cash/card/UPI/bank labels are record categories, not connections to those networks.
- Video appointments: provider/room lifecycle and access control. An online appointment currently does not create a room.
- External calendar synchronization, push subscriptions/alarms, device notification delivery, or external fallback communications.
- Native app packaging/distribution, signing identities, store accounts and release processes. Responsive web/manifest functionality already exists.
- Public domain/TLS/hosting/public indexing: requires explicit deployment authorization. Public indexing is opt-in and the private application must remain excluded.

Do not ask for these now merely because they are on the roadmap. A well-defined integration can often have local adapter, failure-state and contract work completed before credentials are needed, but it should be an intentional new scope, not an implied part of a messaging reliability release.

### 8.3 Clinical, governance, and product decisions

- Validated AI intake/differential support, appropriate sources, intended users, review gates, evaluation and failure behavior.
- Multilingual voice/transcription/text-to-speech and a source-grounded patient assistant; model/provider/data-handling choices and clinically approved content.
- Specialty calculators/scores with verified formulas, source/version history, approved interpretation and review. No invented severity or adherence score should be presented as validated.
- Drug warnings/interactions, contraindication checking and treatment explanations based on approved sources. Current warnings are clinician-entered text.
- Clinician-controlled AI image/video assistance, measurements, similarity retrieval or learning from corrections. Existing originals/comparison/annotation do not validate diagnostic AI.
- Independent consent purposes for treatment, teaching, research, AI use, public before/after imagery and withdrawal. A file-upload acknowledgment does not grant all these rights.
- Complete internal-record release, retention/deletion policy, legal holds and jurisdiction-specific requirements. Patient care-summary portability is implemented but is not the full chart/legal process.
- Medico-legal AI support or claims of evidentiary/legal protection; require defined scope and qualified review.
- Doctor reputation/outcome metrics, review verification, fairness of ranking and visibility for newer clinicians, and privacy-safe professional history.
- Subscription/add-on monetization, usage billing and commercial entitlements. Existing module switches are operational configuration, not SaaS billing.
- Multi-clinic tenancy and cross-clinic authorization; scalable storage/operations after actual requirements are known.
- IPD/hospital workflows, pharmacy dispensing, education/simulation, research/content studio and campus navigation: original concept possibilities, not implemented completion requirements for this single-clinic release.

Do not silently decide critical legal/clinical/business policy just to make a percentage reach 100. State the specific decision and why it blocks a concrete proposed feature when it becomes relevant.

## 9. Runtime and code map

### Runtime

- Node **24** or newer per package engine; last fully tested version **24.13.0**. Built-in `node:sqlite` is used and Node 24 may emit its experimental warning.
- TypeScript, React 19, React Router, Vite, Express, Zod, and local font assets.
- SQLite with foreign keys and WAL; mostly JSON record payloads with indexed supporting columns and immutable-domain tables/triggers.
- One synchronous database connection per server process. Intended deployment is one application instance per database, a modest single clinic. Concurrency tests use independent connections to validate locks, not to claim horizontal scalability.
- Express serves API and built frontend from the same origin in production. Public article HTML is server-rendered separately.
- Images/PDFs are private SQLite BLOBs. Backups contain records, original bytes and auth state; protecting the host/database/backups matters.

### Files to find quickly

| Area                                                   | Main locations                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Router/layout/session                                  | `src/App.tsx`, `src/lib.tsx`, `src/components/ui.tsx`                                                                                                   |
| Public/patient pages                                   | `src/pages/PatientPages.tsx`                                                                                                                            |
| Appointments/clinical record/care plans/staff messages | `src/pages/ClinicPages.tsx`                                                                                                                             |
| Clinical workups                                       | `src/pages/ClinicalWorkflowPanel.tsx`, `server/clinical.ts`                                                                                             |
| Core server, auth helpers, older writers               | `server/app.ts`, `server/db.ts`                                                                                                                         |
| Auth lifecycle/MFA                                     | `server/identity.ts`, `server/auth-security.ts`, `server/mfa.ts`, `server/mfa-crypto.ts`                                                                |
| Ordinary booking                                       | `server/appointment-booking.ts`, `shared/appointment-booking.ts`                                                                                        |
| Move/cancel/progress                                   | `server/appointment-rescheduling.ts`, `server/appointment-cancellation.ts`, `server/appointment-state-change.ts` and matching `shared/` files/forms     |
| Weekly schedule/time off/pause                         | `server/scheduling.ts`, `server/weekly-availability.ts`, `server/time-off.ts`, `server/doctor-booking.ts`                                               |
| Series/length/resources                                | `server/appointment-series*.ts`, `server/visit-duration.ts`, `server/clinic-resources.ts`                                                               |
| Notes/amendments                                       | `server/consultation-recording.ts`, `shared/consultation-recording.ts`, `src/components/ConsultationNoteModal.tsx`, `consultation-recording-helpers.ts` |
| Follow-up/activity/reminders                           | `server/follow-up.ts`, `server/follow-up-escalation.ts`, `server/activity.ts`, `server/appointment-reminders.ts`                                        |
| Investigation/procedure coordination                   | `server/investigation-worklist.ts`, `server/procedure-catalogue.ts`, `server/procedure-scheduling.ts`                                                   |
| Files/annotations/summary                              | `server/documents.ts`, `server/image-annotations.ts`, `server/care-summary*.ts`; matching components and `CareSummaryPage.tsx`                          |
| Finance                                                | `server/operations.ts`, `server/billing-corrections.ts`, `server/insights.ts`, `src/pages/OperationsPages.tsx`, `InsightsPage.tsx`, `ExpensesPage.tsx`  |
| Other operations                                       | `server/inventory.ts`, `server/attendance.ts`, `server/record-search.ts`, `server/patient-profile.ts`                                                   |
| Public content/config                                  | `server/public-library.ts`, `server/knowledge-authoring.ts`, `server/clinic-configuration.ts`                                                           |
| Runtime/backup/recovery                                | `server/index.ts`, `server/production.ts`, `server/backup.ts`, `server/database-recovery.ts`, `server/restore.ts`                                       |
| Tests                                                  | `tests/*.test.ts`, `tests/browser/*.spec.ts`, `tests/fixtures/`                                                                                         |
| Isolated smoke harnesses                               | `scripts/production-smoke.mjs`, `scripts/recovery-smoke.mjs`, `scripts/e2e-server.mjs`                                                                  |

Use `rg`/`rg --files` for discovery. Prefer existing focused components/services over growing the large page/core files unnecessarily, but do not perform a broad architecture cleanup as a prerequisite to a bounded feature.

## 10. Behavior and security invariants to preserve

### 10.1 Access and clinical authorship

- Clinicians have clinic-wide clinical access; this is not a clinician-patient assignment isolation model.
- Patients see only their own patient-facing records. Reception sees demographics, appointments, waitlist and billing/minimal billing projections, not full clinical records, notes, images, PDFs, care plans or private messages.
- `GET /patients/:id` as reception returns **403** under the current care-record policy. Earlier new tests mistakenly expected a sanitized 200 and were corrected. Do not “fix” the server to satisfy that wrong expectation.
- Clinical note/amendment/care-plan authorship requires an active valid linked doctor profile, including for an administrator. A bootstrap admin has no clinician identity until explicitly linked.
- Appointment progression has a different role model: reception may check in/mark no-show; doctor/admin may start/complete, with no linked-doctor requirement just for changing visit status. Do not conflate this with note authorship.
- Internal notes/amendments, private follow-up assessments/report snapshots, unpublished investigation interpretations, internal reasons and command metadata stay out of patient/public projections.
- Notifications should use appropriate generic text; do not copy private clinical note bodies into activity or audit.
- Optional module pause stops applicable new activity while preserving existing records. Authorization remains enforced even when replay is allowed after a later policy pause.
- The core `actor()` helper reads middleware-cached `req.user`; invoking that helper again inside a transaction is not necessarily fresh database authorization. Inspect the newer service implementation when adding under-lock checks. The strong pattern described below is established in recent modules, not universally applied to every legacy writer.

### 10.2 Exact commands and immutable evidence

The recent releases established a pattern worth preserving, but each workflow must keep its own semantics:

1. Normalize and validate a strict command; generate one UUID for the exact reviewed intention.
2. Acquire the write transaction (`BEGIN IMMEDIATE` in current modules).
3. Recheck current session/expiry/CSRF/active account/password rotation/MFA/role/ownership/link requirements **inside the lock**, before a new write and before replay.
4. Look up the command and bind the UUID to actor, action, source/patient and full normalized payload or digest. A collision is not a successful retry and not proof of non-application.
5. After fresh authorization and exact binding, **return an existing success or terminal rejection before new-attempt revision/business-eligibility checks**. A later moved appointment, changed schedule, expired booking time or paused module must not invalidate a previously committed original confirmation where the contract permits replay. Current authority is still required. Return current mutable state separately if needed; never rewrite original evidence to look current.
6. Only for a genuinely new command, check its reviewed source revision and current business eligibility. The appointment source counter detects changes away and back, including legacy/series/duration writes. Do not hash arbitrary clock ticks into a source revision. Follow the endpoint's specific access and module rules instead of mechanically moving every check across replay.
7. Commit domain records, resource changes, immutable event/receipt, audit and relevant activity together.
8. A definitive rejected command must have durable non-application evidence. Roll back attempted effects to a savepoint before storing the terminal rejection. Exact replay of that rejection stays rejected even if conditions later change.
9. Authentication/schema/collision/unknown errors do not automatically establish that a previous attempt failed to commit. Do not unlock an uncertain form based only on HTTP status.
10. Keep private command IDs/reasons/receipts out of ordinary shared record projections. Existing baseline data gets no invented prior author/history.

Stored evidence improves application integrity; it is not tamper-proof against a database administrator. Do not add legal claims.

### 10.3 Frontend asynchronous behavior

- Validate result actor, request, action, patient/source IDs, expected immutable content and actual author where applicable. TypeScript generics alone do not validate a network response.
- Keep the exact pending payload/UUID locked while the result is unknown. Repeatedly generating a new UUID defeats idempotency.
- Unlock only after a validated success or fully matching durable rejection; a fresh reviewed attempt after rejection uses a fresh UUID.
- Preserve draft edits when stale review requires a refresh. Do not silently apply newly loaded values without acknowledgment.
- Show a saved confirmation before parent refresh destroys it. Reload lists/records after the user closes the confirmation where that is the established flow.
- Pending clinical content is page memory only. Do not put medical text or commands in `localStorage`, `sessionStorage`, analytics, or offline caches.
- Use the established route/account/native-history guard before the API helper's global 401/session-expiry side effect. A simple mounted flag or a check after `await api()` is too late.
- `src/components/appointment-booking-helpers.ts` contains `useAppointmentBookingGuard` and `useAppointmentBookingData`, reused beyond booking. Names are historical; there is no need for a broad generic refactor just to reuse them.
- Guards consider actor, React location key, native href/history key, navigation generation, popstate/hash/session events and unmount. Test leaving and returning via Back; matching pathname alone is insufficient.
- Consultation pending commands persist across same-patient record-tab/query changes, while the active modal closes and obsolete callbacks are invalidated. Patient/account changes, leaving the record/unmount, native leave then Back, and reload discard them. Other existing workflows may intentionally reset on navigation; do not claim browser-reload recovery exists.

### 10.4 Scheduling details that have caused incorrect assumptions

- New public bookings cannot be in the past. Existing cancellation/status/note rules are different.
- Individual reviewed rescheduling is for future scheduled visits; custom duration stays fixed, while default duration/fee/name use the applicable reviewed target rules.
- Patients can cancel their own scheduled visits, including past scheduled visits. Staff can also cancel checked-in visits. Do not invent a universal future-only cancellation rule.
- Check-in is `scheduled → checked-in`; start is `checked-in → in-consultation`; complete is `in-consultation → completed`; no-show is `scheduled → no-show`.
- All four staff progression actions require appointment date at or before the current clinic date. Only no-show additionally requires the exact scheduled start to have been reached. Same-day early check-in/start/completion and past visits remain permitted by current policy.
- Check-in/start/completion retain recorded resource intervals. No-show/cancellation release reservations. Completion does not erase historical occupancy.
- A status change changes status only and preserves original names, fee, date/time, duration including legacy omission, and unrelated fields.
- Doctor booking pause blocks new bookings, new waitlist intake/fulfillment and incoming doctor transfers. Existing same-doctor eligible moves remain possible. Pause, account suspension, weekly hours, leave and profile visibility are separate controls.
- Procedure completion, clinical documentation, invoice creation, refunds and waitlist reopening are separate actions. Do not infer them from appointment status changes.

### 10.5 Finance, files and recovery

- Use integer paise for exact amounts. Recorded refunds move no money; voiding a mistaken refund is a correction, not a new payment.
- Reports use different date cohorts deliberately: scheduled dates for appointments, issuance dates for invoices, entry dates for receipts, and incurred dates for expenses. “Outstanding” is the current balance of invoices issued in the range, not reconstructed historical debt or profit.
- Preserve original clinical files, content-type/signature/size checks, hashes and private downloads. Do not replace originals with annotation-rendered images.
- Saved summaries preserve exact bytes and schema version. Later optional fields absent in a legitimate historical copy must not invalidate that archived copy; current live schemas can fail closed when required fields are missing.
- Summary bundles are explicitly selected, bounded and generated in memory: up to 20 attachments, 5 MiB per original, 25 MiB total ZIP. They are unencrypted downloads outside app access control after saving.
- Do not copy only a live SQLite main file and assume WAL is included. Use the online backup tool.
- Restore writes a new file and retires sessions, recovery grants, MFA challenges/preparations and all stored MFA recovery-code rows. It preserves enrolled encrypted credentials and advances their accepted-step guard monotonically. The original MFA key remains necessary.
- Recovery cannot reconstruct changes after the snapshot. Do not automatically switch or overwrite a live database.

## 11. Latest completed feature: v1.39 technical continuity

This detail is included so a new AI does not repeat the most recently finished work.

**Endpoints:**

```text
POST /api/consultation-notes
  {patientId, appointmentId?, history?, examination?, assessment,
   investigations?, plan, reviewedConfirmed:true, requestId}

POST /api/encounters/:id/amendment-recordings
  {reason, text, reviewedConfirmed:true, requestId}
```

Both return 201 for a new recording, 200 for an exact replay:

```text
{
  encounter: original immutable note,
  amendment: original immutable amendment | null,
  receipt: {
    requestId, actorId, operation:'create'|'amend', patientId,
    encounterId, amendmentId:string|null, doctorId
  }
}
```

The receipt doctor is the author of the operation; an amendment can have a different author from the original note. Later amendments, appointment changes and profile rename/relink do not change an earlier result. Fresh currently valid linked-clinician access is still required to replay.

New routes reject unknown query/body fields. IDs trim to 1–300 characters; clinical text trims to at most 8,000. Assessment and plan are required; history/examination/investigations default blank. Amendment reason/text are required. UUIDs normalize to lowercase.

`consultationRecordingCommands` stores immutable actor/operation/patient/source bindings, a SHA-256 normalized-payload digest, and exactly one success receipt or rejection. It avoids a second copy of clinical text in command metadata. There is no source revision because these append records rather than replace a reviewed source. Optional appointment linkage requires the same patient only, without a new date/status/assigned-doctor restriction.

Known eligible domain failures can store:

```text
{error, consultationOutcome:'not-recorded', requestId, actorId,
 operation, patientId, encounterId:null-for-create-or-source-id-for-amend}
```

Missing private patient/encounter authorization, auth, invalid clinician link, schema errors, command collisions and unknown failures do not return that proof. Exact rejected commands never later apply. Legacy `POST /api/encounters` and `/api/encounters/:id/amendments` retain their old plain 201/field-stripping behavior, but now use the same fresh-authorized atomic writer; they do not acquire a UUID guarantee.

`registerConsultationRecording` runs after `registerClinical`, which creates the amendment table/triggers. Shared `ConsultationNoteModal` handles original and amendment forms. `PatientDetailPage` owns one pending command for both operations; `EncounterAmendments` keeps its list and opens the shared modal. The note's original contents remain unchanged. No patient notification or patient-summary revision is created by a private note/amendment.

Focused tests: 15 new API groups plus 10 existing clinical groups; 5 new browser journeys plus 11 affected compatibility journeys. Coverage includes 63 current-auth/session/MFA/profile races, 10 mutation/audit/receipt rollback points, concurrent connections, collisions, exact author attribution, restart, terminal rejection and privacy. Full totals are 683 and 138. Mobile screenshots verified review, uncertain retry and saved amendment controls at 320 pixels.

## 12. Running locally and verifying a substantial release

### 12.1 Demo and development

From the repository root:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The development API normally runs on port 3001. Default demo data is `data/clinic.sqlite` and persists across restarts. Do not delete it to get a clean test; the test harnesses create separate temporary databases.

Intentionally public **development-only** accounts:

| Role          | Email                  | Password          |
| ------------- | ---------------------- | ----------------- |
| Doctor        | `doctor@derma.demo`    | `DemoClinic2026!` |
| Reception     | `reception@derma.demo` | `DemoClinic2026!` |
| Patient       | `patient@derma.demo`   | `DemoClinic2026!` |
| Administrator | `admin@derma.demo`     | `DemoClinic2026!` |

All seeded people/content are fictional. Production refuses a demo-seeded database. Do not reuse these credentials for anything real.

`npm start` is production mode, even for a local process. Secure cookies require HTTPS in a normal browser. Use the disposable production smoke harness for automated production behavior rather than weakening cookie security to make an HTTP manual login work.

### 12.2 Current check commands

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:production
npm run test:recovery
npm run format:check
npm audit --omit=dev --audit-level=low
docker compose config --quiet
```

`npm run build` includes typecheck then Vite build. `npm run check` combines typecheck, API tests and build. Avoid repeating expensive checks without a new change or unresolved concern. The ZIP interoperability API tests also use Python 3's standard-library `zipfile`; this is a test prerequisite, not an application runtime dependency.

For a release's local container checks, choose a version-specific local tag:

```sh
docker build -t derma-clinic:local-v1.40 .
npm run test:production -- --image derma-clinic:local-v1.40
npm run test:recovery -- --image derma-clinic:local-v1.40
```

These commands build/test locally. They do not push an image or deploy hosting. The production container smoke binds only a random loopback port and removes disposable resources; the recovery container rehearsal publishes no port.

Use focused API/browser tests first to get fast feedback, then the appropriate full release checks once source is stable. For example, the last release used:

```sh
node --import tsx --test tests/consultation-recording.test.ts tests/clinical.test.ts
npx playwright test --project=consultation-notes
```

Check actual test/project names before reusing them for a future release.

### 12.3 Browser harness details

- Playwright has one worker and independent temporary database/server groups. Authentication throttles remain enabled; do not disable them to hide test collisions.
- Local browser defaults to installed Google Chrome; `PLAYWRIGHT_CHANNEL` can select a supported channel. CI uses Playwright Chromium after installation.
- Existing v1.39 frontend test ports are **5183–5215**, API ports **3011–3043**. If adding a genuinely separate group, **5216/3044** are the next candidate pair; check availability/config first.
- `reuseExistingServer` is false. Do not run two Playwright sessions simultaneously against the same configured ports. Coordinate focused tests and full tests across agents.
- The current configuration declares the whole web-server array, so even a focused project can start the other configured servers. Do not assume unused projects leave their ports free.
- `scripts/e2e-server.mjs` owns disposable fixtures and cleanup. Preserve existing rate-limit behavior.
- Browser fixtures generate an isolated MFA key and disable automatic escalation/reminder timers for deterministic manual-run tests. Production runtime worker behavior is separately exercised; disabling fixture timers does not mean the feature is missing.
- Progression tests use `E2E_APPOINTMENT_STATE_FIXTURES=1` only in their isolated project. `tests/fixtures/appointment-state-change.ts` creates guarded synthetic past/current/future appointments and resource snapshots in a new temporary test/demo database.
- Public booking still forbids past bookings. Browser-only clock overrides do not change server time. Do not add a production fixture endpoint or weaken production validation to make date-sensitive tests convenient.
- A no-op legacy appointment PATCH does not increment a mutation revision; use a real source change when testing stale review.
- Full v1.39 browser suite took about **8.9 minutes** on the prior machine. Long running time is normal; provide progress while it runs.

### 12.4 Mobile and asynchronous verification

- Test meaningful 320×860 states, not just a desktop screenshot scaled down.
- Run axe in the actual review, pending-retry and confirmation states relevant to the feature. Automated axe coverage is bounded.
- A sticky modal footer can cover a button while `toBeInViewport()` passes. Center-scroll the target and use `elementFromPoint` at the control to prove it is unobscured.
- Prefer viewport screenshots for dialogs; full-page screenshots can include a large irrelevant background.
- Existing global `.notice` layout is flex; a feature may need a scoped `display: block`. Use existing CSS variables such as `--line`; do not assume an undefined `--border`.
- Explicit checkbox sizing avoids global mobile input width rules stretching it.
- Test actual navigation, late success, late 401, and leaving then Back; do not only abort a mock and infer the guard works.
- If a test fails, distinguish a wrong test premise from a product defect. Prior reception-privacy and no-op-revision failures were test assumptions; permission semantics were preserved.

### 12.5 Production and restore evidence

- `scripts/production-smoke.mjs` bootstraps a fresh synthetic production database and administrator via stdin, checks real API/auth/headers/build behavior, and cleans up.
- `scripts/recovery-smoke.mjs` uses actual backup/verify/restore commands and opens the restored app. It checks retained records/files/receipts, retired access, audit evidence and a fresh authenticator login.
- Fresh authenticator replay protection may require waiting up to 90 seconds in the recovery rehearsal; do not remove the wait or weaken the guard to speed up a test.
- When adding a durable command table, verify retention after backup/recovery and original-versus-current semantics if relevant.
- Production fixtures may use isolated startup SQL for historical synthetic visits; no live clinic database is involved.
- Docker recovery/production commands are important local runtime evidence, but no network provider, real clinic backup or public installation has been validated by them.

### 12.6 Evidence retained from v1.39

The durable verification record is [docs/VERIFICATION.md](../../docs/VERIFICATION.md). Optional temporary artifacts from the prior machine may still exist:

```text
/private/tmp/doctor-v1.39-api.log
/private/tmp/doctor-v1.39-consultation-browser.log
/private/tmp/doctor-v1.39-consultation-compat.log
/private/tmp/doctor-v1.39-browser.log
/private/tmp/doctor-v1.39-build.log
/private/tmp/doctor-v1.39-docker-build.log
/private/tmp/doctor-v1.39-production.log
/private/tmp/doctor-v1.39-production-docker.log
/private/tmp/doctor-v1.39-recovery.log
/private/tmp/doctor-v1.39-recovery-docker.log
/private/tmp/doctor-v1.39-audit.log
/private/tmp/doctor-v1.39-format.log
/private/tmp/doctor-v1.39-consultation-screenshots/
```

Screenshots there: `consultation-note-review-mobile.png`, `consultation-note-pending-mobile.png`, `consultation-amendment-confirmed-mobile.png`. A local image `derma-clinic:local-v1.39` was retained. Prior test listeners and disposable `derma-smoke-*`/`derma-recovery-*` containers were stopped/removed at release completion. Do not assume temporary logs/images still exist or are required dependencies in a new environment.

The latest note appointment selector was refined to include date, time, doctor, status and reason. Assets/image were rebuilt and final Docker production smoke rerun afterward. There are no outstanding failed checks from that release. No implementation test suite was rerun merely to produce this handoff document.

## 13. Practical one-release workflow

1. **Establish the baseline.** Check branch/status/latest commit, current docs, source and tests. Read relevant local instructions. Preserve unrelated changes.
2. **Choose one material gap.** Give a short commentary stating the intended user benefit. Do not ask the user to decide routine component/API details.
3. **Lock the semantics early.** Read current roles, eligibility, privacy, notices and legacy adapters. Agree on command/receipt/rejection DTOs before parallel edits. Source-based review is needed for state replacement, not automatically for every append-only record.
4. **Divide work cleanly if agents are available.** A useful split is backend/shared/API tests; UI/helpers/styles; browser journeys/compatibility. Root owns integration review, config/version/docs, production/recovery smoke updates and final release. Avoid two agents writing the same file without coordination.
5. **Review independently.** Have another agent or a separate review pass inspect transaction boundaries, replay authorization, payload/author matching, privacy, and stale navigation before relying on green happy-path tests.
6. **Run focused checks.** Backend tests first, then new browser and affected compatibility tests in a coordinated port window. Freeze product source before the full verification pass.
7. **Update meaningful release evidence.** Bump `package.json` and lockfile version together for the actual substantial release. Update README/PRODUCT/ARCHITECTURE/API/VERIFICATION only with relevant changes and actual counts/date. Adjust the Playwright project/README port ranges if needed. Do not claim future tests passed.
8. **Verify final source.** Full API suite/build; full browser suite; local and Docker production/recovery checks as appropriate to the domain; production dependency audit; formatting, whitespace, Compose configuration. Rerun only checks affected by a later source fix, broadening when evidence warrants it.
9. **Clean up safely.** Stop owned test servers/containers, retain useful logs/screenshots, inspect `git diff --check`, final diff/stat and status. Do not kill unrelated user processes or delete user data.
10. **Commit one coherent release.** Stage explicit release files rather than indiscriminately staging everything. Review cached diff/whitespace. Commit with a concrete feature description, push the authorized branch, verify local HEAD equals the remote branch head and inspect the remaining working tree.
11. **Respond and stop.** Explain the completed behavior, actual test evidence, commit link and “Nothing deployed.” Wait for the next go-ahead.

The old environment required elevated sandbox execution for `.git` writes, network, local servers/browser/Docker. Automatic approval review consistently allowed authorized actions. In a new environment, use its permission mechanisms. Do not turn routine tool approval into a redundant user question. If an automatic reviewer actually rejects an action and there is no safer authorized route, state the exact blocked action/reason; do not imply a user denial or silently bypass it.

Useful log convention for the next release is `/private/tmp/doctor-v1.40-<check>.log`. Use a safe task-specific variable name if scripting; do not repurpose `HOME` or `CODEX_HOME`. Keep secrets out of shell arguments, logs, source and screenshots. For multiline GitHub text, use a file/structured argument, not fragile interpolated shell strings.

Formatting is Prettier. Format changed files deliberately; do not run an indiscriminate repository rewrite across user reference material. Existing build/tests are the relevant tools; no provider plugin, stack migration, new dependency or web research is required merely to resume the known local reliability tasks.

## 14. Honest status and stopping points

The project is already a substantial working application, not a mockup awaiting a backend. Its main local workflows, identity controls, clinical records, scheduling, operations, history, exports and recovery have been built and repeatedly exercised.

The remaining autonomous work is concentrated in older write/composer flows that have not yet received the same uncertain-response, current-authorization and navigation treatment as recent features. The four primary candidates are messaging, intake, care-plan creation and uploads, followed by a bounded final audit of the identified older finance/clinical forms.

The broader original vision still includes unimplemented AI, voice, providers, native distribution, advanced professional identity, complete governance/retention and multi-clinic features. Their presence in the concept is not evidence that a key-only setup will activate them. Their absence also does not mean the working clinic platform must be rewritten before finishing the local scope.

If asked for an updated completion percentage, anchor it to a stated scope, completed releases and remaining concrete tasks. The last number was **8–10% remaining on the AI's autonomous local side**. It should not change merely because another chat starts or a handoff document was written.

## 15. Ready-to-paste continuation prompt

> Continue the dermatology platform from the local main checkout. Read the latest checkpoint at the top of this handoff, the README, PRODUCT and VERIFICATION, then inspect Git status and recent local commits. Use synthetic data to reproduce the next outstanding issue. Finish one substantial change, verify it, update the handoff, commit and try to push the completed source. Keep deployment separate. Report the result and stop until I say continue. Ask me only when a decision or external dependency needs my involvement.

The user can substitute a different next task. This prompt summarizes the established agreement; current explicit user instructions take precedence over this handoff.

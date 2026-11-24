# Derma clinic platform — AI continuation handoff

**24 November 2026 · v1.57.0 · Awaiting clinic input.** The named autonomous implementation and reliability work is complete. The user installed Docker Desktop and has viewed the working local demo. They want to return when they are ready with their clinic inputs. No production clinic has been set up or deployed. A new chat can use this document without the previous conversation.

[Start here](#1-start-here) · [Product idea](#4-product-vision-versus-implemented-release-scope) · [Built capabilities](#5-what-is-already-built) · [Release history](#6-release-history) · [Verification evidence](#7-completed-autonomous-work-and-verification) · [Remaining manual work](#8-manual-external-or-deliberately-deferred-work) · [View the demo](#121-view-the-local-demo) · [New-chat prompt](#15-ready-to-paste-continuation-prompt)

## 1. Start here

| Item | Current checkpoint |
| --- | --- |
| What this is | **Derma — care, connected**, a responsive dermatology platform for one clinic, with a public site, staff workspace and patient portal. |
| Checkout and branch | `/Users/rakshit/Desktop/doctor` on this Mac, branch `main`. In another environment use the root reported by `git rev-parse --show-toplevel`. [GitHub repository](https://github.com/rakshitachopade2-del/doctor) |
| Product and verification commits | Five clinical workflow improvements shipped in [eca68a8](https://github.com/rakshitachopade2-del/doctor/commit/eca68a869507d316a28d5399bfd669f846d5a3c3). Container CI followed in [87730fb](https://github.com/rakshitachopade2-del/doctor/commit/87730fb4e94769ab1745eb60bfd669f846d5a3c3). Later handoff-only commits can advance `main` without changing the product version. |
| Verified | 830 API, backup and recovery tests, 253 Chrome journeys and both production-image rehearsals. All 13 GitHub Actions jobs passed on the verification commit. Section 7 identifies what each check exercised. |
| Last user action | The user viewed the loopback demo with fictional records. Its four role buttons work without typing a password. [Open the demo on the same Mac](http://127.0.0.1:5173/login) |
| Current stopping point | The first outstanding decision is the **public clinic profile**. Team, schedule, content, governance and eventual operations follow in section 8. There is no assigned coding task, release or deployment in progress. |

### How to respond in a new chat

- **“Continue” or “what remains?” with no new inputs.** Check whether this checkpoint has changed. If it still applies, tell the user that the planned automated work is finished. If they are ready to start onboarding, ask only for the first missing item in section 8.1. The user has already viewed the demo.
- **“Let me view it.”** Check the local session and health, then give the working login link. Restart a synthetic preview only if needed. Section 12.1 gives the commands.
- **The user supplies clinic details.** Start at the corresponding step in section 8. Use the supplied values and preserve prior decisions. If the destination for a write is unclear, establish whether the user wants a local preview with approved public information or configuration in a designated private installation. Return evidence of what was actually configured and identify the next missing input.
- **The user reports a defect or chooses new functionality.** Establish the affected role and expected result, reproduce it with synthetic data and complete the authorized work. Use section 13 for changes to the software. The optional roadmap in section 8 does not schedule itself.
- **The user explicitly authorizes a real installation or service.** Confirm its target and scope, then use the operator runbook in section 8. Decisions about publishing, external providers and handling patient data remain with the clinic.

Before changing anything, inspect the current checkout, latest commits, applicable repository instructions and working tree. Source, tests and the user's latest instructions take precedence over a dated snapshot. Preserve user changes and the viewing session.

## 2. The user's working agreement

The user expects Codex to make routine engineering decisions, use synthetic fixtures, run the software and verify results independently. Development and viewing have been local to the Mac, with source control and disposable GitHub Actions runners also authorized. Public hosting, a tunnel, real delivery, real payments and production data entry require a separate request.

When there is an authorized engineering task, finish one substantial coherent change and push the verified source to the linked repository. The user may explicitly ask for a larger batch. Give the result, evidence and outstanding decisions, then wait for their next instruction. A status or viewing request is complete when that information or working link is delivered. The user will return when ready with their manual inputs.

Use the supplied concept and references for context. The project already implements authentication and a working application. Keep real patient records, private clinic data, live passwords, keys and recovery links outside chats, Git, screenshots and test fixtures. Multiple agents, old chat memory and temporary logs are unnecessary for resuming from this handoff.

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

The original concept document was supplied outside Git. Its historical path on the previous machine was

`/Users/rakshitchopade/Downloads/Dermatology_Clinic_Platform_Concept_Document.docx`

This file is outside the checkout. If it is unavailable in the new environment, continue from the checked-in product coverage and this handoff; ask for it only when a particular unresolved concept requires it. Do not invent its missing contents.

Supplied repository references:

- [Starter_Pack_Brief_For_Wireframing.md](../Starter_Pack_Brief_For_Wireframing.md)
- [SEO Playbook Google + AI Search.md](../SEO%20Playbook%20Google%20%2B%20AI%20Search.md)
- [general_authentication_reference_guide_v2.docx](../general_authentication_reference_guide_v2.docx)

The wireframing brief describes another **Next.js SEO starter** with route registries, template gates, and its own rules. This product is **React/Vite + Express**, with a server-rendered public article layer. Do not replace the stack, impose the other template's commands, invent search targets for private routes, or rebuild the application around that reference. Useful accessibility/public-content principles can be applied when relevant. Public library SEO already exists. Private medical routes must remain private and unindexed.

The references are preserved under `dev_ref`. This handoff is the continuation document the user asked Codex to maintain.

## 4. Product vision versus implemented release scope

The original idea connects the whole dermatology care journey. A patient can discover a clinician, book an appointment, share a history and images, receive a care plan, and return for follow-up. Staff need a common record of who saw the patient, what was agreed, what was shared and what still needs review. The broader concept also explores professional identity, optional modules, multilingual voice, clinical decision support and mobile distribution.

The shipped product serves one clinic through a responsive web app. A typical journey starts with a public doctor profile, continues through booking and reception check-in, and reaches a linked clinician’s private chart. The clinician can order an investigation, review a result, decide what to publish, discuss a procedure and record aftercare. Patients see shared material in their portal. Staff can coordinate return visits and record charges and payments. The portal and staff workspace run with the local API, SQLite and in-app activity.

Decisions about clinical validation, provider-backed communication, money transfers, native apps and multiple clinics belong to future scopes. The checked-in product guide maps the original concept to actual behavior. Its “Remaining substantial releases” section lists options the owner can prioritize later. [Product decisions](../../docs/PRODUCT.md)

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

## 6. Release history

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
| 1.40 | `b8784d7` | Private care message recovery |
| 1.41 | `3042e65` | Reviewed patient intake |
| 1.42 | `fb53707` | Care-plan creation |
| 1.43 | `26766fd` | Private image and PDF uploads |
| 1.44 | `22440a7` | Staff invoice issuance |
| 1.45 | `99c6557` | Recording a received payment |
| 1.46 | `ff80541` | Daily patient check-ins and corrections |
| 1.47 | `6602295` | Clinician follow-up reviews |
| 1.48 | `7cc8c46` | Investigation result submission |
| 1.49 | `fd5f7e3` | Recording and changing procedure decisions |
| 1.50 | `40a48a3` | Procedure completion and aftercare |
| 1.51 | `0cdabd1` | Staff patient registration |
| 1.52 | `99c2f39` | Staff-account creation and password-free outcome checks |
| 1.53 | `f605b88` | Doctor profile creation |
| 1.54 | `d2f587c` | Concurrent public doctor profile edits |
| 1.55 | `6f650db` | Investigation ordering |
| 1.56 | `c9a4315` | Investigation cancellation |
| 1.57 | `eca68a8` | Procedure plans, visit changes and cancellation, investigation reviews and handovers |

The release notes record original failures, outcomes and regression evidence for v1.40–v1.57. The CI follow-up at `87730fb` also ran the image and restore tests on hosted Linux. The historical handoff preserves the original triage and the detailed v1.39 consultation-note design. [Release evidence](../../docs/VERIFICATION.md) · [Archived November 20 handoff](https://github.com/rakshitachopade2-del/doctor/blob/ecc8aa6576293207483d94d9af014884d8e0fcd4/dev_ref/ref/AI_CONTINUATION_HANDOFF.md)

## 7. Completed autonomous work and verification

All six areas in the original handoff have been addressed. Sections A–D covered private messages, intake, care-plan creation and private uploads (v1.40–v1.43). Area E covered billing and clinical workflows (v1.44–v1.50 and v1.55–v1.57). Area F covered registration, staff accounts and doctor profile creation/editing (v1.51–v1.54). Together these releases cover lost replies, intentional separate submissions, changing source records, authorization, atomic writes and patient visibility according to each workflow. The individual outcomes are in sections 6 and 11 and the release notes.

| Evidence from 24 November 2026 | What was confirmed |
| --- | --- |
| Local v1.57 regression suite | 830 API, backup and recovery tests and 253 browser journeys across 55 projects passed with Node 24.22.3 and Google Chrome. The five v1.57 workflows added 24 API tests and 22 journeys, including 12 automated accessibility checks at 320 pixels. TypeScript, formatting, the production build, native production smoke and backup/restore rehearsal passed. [Verification record](../../docs/VERIFICATION.md) |
| Upgrade from v1.56 | All 17 captured tables matched row for row, including 43 appointments, a linked invoice, a published interpretation and a private handover. The four new evidence tables began empty. After restart, all five workflows could confirm their earlier successes and refusals without duplicating records, audit events or notices. [Upgrade results](../../docs/VERIFICATION.md) |
| GitHub Actions on `87730fb` | All 13 jobs passed, covering the build/API checks, 11 browser groups and an independent production-image job. The latter built the image, exercised the packaged application on loopback and restored a synthetic backup inside a fresh container. [Full run](https://github.com/rakshitachopade2-del/doctor/actions/runs/45354209523) · [Container job](https://github.com/rakshitachopade2-del/doctor/actions/runs/45354209523/job/138307870354) |
| Subsequent Mac Docker check on the same source | After the user installed Docker Desktop, the `linux/arm64` image built on their Mac and ran as the `node` user. Both the production smoke and backup-and-restore rehearsal passed locally, including rejection of retired credentials and fresh authenticator sign-in. The disposable test containers and preview build tag were cleaned up. This completes the local check listed as unavailable at the time of the original v1.57 suite. |
| Human actions already completed | The user installed Docker Desktop and viewed the seeded demo. Codex checked the login link and opened the Admin dashboard. There has been no real-patient trial, clinic-policy approval, production cutover or public launch. |

The production and recovery checks used synthetic records. Real clinic acceptance, ongoing off-site backup operation and any later production cutover belong to the operator and have separate evidence in section 8 once performed.

## 8. Manual, external, or deliberately deferred work

**Onboarding status:** the clinic has yet to supply its approved operating details. Docker installation and demo viewing are complete. The user wishes to provide the remaining inputs when ready. Start with the public profile. Subsequent steps can be handled in stages, and optional integrations can remain undecided.

### 8.1 Future clinic/operator setup

#### Step 1. Public profile

**From the clinic owner.** Approved public clinic name, contact phone, email, address and opening-hours text. Include a tagline if desired. The current clinic time zone is Asia/Kolkata.

**Configuration and verification.** Enter the supplied fields in **Clinic settings → Clinic profile → Public clinic information** in the agreed environment. Provide the change reason, then compare the public display with the supplied details and inspect **Configuration history**. These hours describe the clinic. Each doctor’s bookable sessions are set in step 3. [Clinic profile guide](../../README.md#review-clinic-configuration-changes)

#### Step 2. Team and access

**From the owner or clinic administrator.** Approved clinician roster and public profile details (qualifications, specialties, languages, experience and fees). Identify which staff members handle reception, clinical care or administration and which clinician profile each clinical author should use.

**Configuration and verification.** **Clinic settings → Your team** manages public doctor profiles and individual accounts separately. Verify the approved fee/public profile, role and doctor linkage. Check role boundaries using synthetic accounts first. The clinic verifies identity before linking an existing patient chart to a portal account and hands out real credentials privately. [Team setup](../../README.md#set-availability-and-manage-access)

#### Step 3. Booking and resources

**From the scheduling lead.** Per-doctor weekly sessions, breaks, visit length, in-person/online modes, leave, clinic closures, new-booking status, rooms/equipment, and any maintenance windows.

**Configuration and verification.** In **Availability & time off**, configure weekly sessions and closures. Configure approved resources if used. Test sample slots, a closure and an existing booking in a synthetic rehearsal. Check the displayed time, doctor, fee and duration before the clinic approves the schedule. [Weekly availability](../../README.md#review-changes-to-weekly-availability)

#### Step 4. Daily operations and policies

**From the clinic manager.** Initial stock/lots if inventory will be used, billing descriptions and fees, who can record and correct external payments, desired care modules, follow-up escalation rules and appointment reminder lead time.

**Configuration and verification.** Configure the selected modules and policies. Rehearse a sample invoice/payment and, where enabled, a follow-up or reminder in the in-app inbox. Check role access, timing, history and duplicate prevention. Timed checks require a running service. The clinic supplies its real opening balances and owns reconciliation. [Product guide](../../docs/PRODUCT.md) · [Reminder operation](../../docs/DEPLOYMENT.md#appointment-reminder-operation)

#### Step 5. Patient-facing content and record handling

**From the responsible clinician and clinic owner.** Supply approved procedure wording, educational copy, care instructions and aftercare. Decide permitted collection and use of photos/PDFs, access and release of records, retention, deletion/holds and handling requests or incidents. Identify the reviewer for each.

**Configuration and verification.** Place supplied reusable procedure text and articles into the existing draft and review flows. Follow approval for the particular audience and publication target. Rehearse the patient view, private notes, unpublished interpretations and exported contents with fictional cases. Record policy gaps separately if the clinic’s requirements exceed current software. The clinic’s qualified reviewers own the wording and policy decisions. [Procedure catalogue](../../README.md#reuse-reviewed-procedure-information) · [Patient-record API](../../docs/API.md#patient-records-and-care)

#### Step 6. Acceptance and operations

**From the clinic owner, clinician and operator.** Decide who accepts each role’s workflows and who owns day-to-day administration, security, backups and recovery. If the clinic wants a live installation, choose host, domain, trusted origin, TLS, protected storage and responsible operators. Give explicit deployment authorization separately.

**Configuration and verification.** Help rehearse the accepted workflow on synthetic data, record outstanding issues, and prepare the operator steps. For an approved installation use a fresh production database, an individually controlled administrator, protected credentials, and MFA key custody if MFA is enabled. Agree on backup frequency, retention and off-site storage. Verify that a separate copy restores and can be opened before any real cutover. [Production setup](../../docs/DEPLOYMENT.md#prepare-a-fresh-production-database) · [Backup and recovery](../../docs/DEPLOYMENT.md#backup-and-recovery)

**First input when the user is ready:** “What public clinic name, phone number, email, address and opening hours should appear in Clinic settings?” Accept partial answers and leave outstanding values pending. There is no need to request staff credentials, patient information or provider accounts for this step.

**Where real data belongs.** The bundled `data/clinic.sqlite` is tracked demo data. The viewing session uses a separate temporary database. If the user wants durable onboarding, agree on a private persistent database outside the checkout and apply the approved setup there. Demo account credentials belong only to synthetic environments. Use the bootstrap and credential-handling procedure in the operator guide for actual accounts. Keep secrets and identifiable patient or staff data out of this handoff.

**What counts as clinic acceptance.** A designated reviewer can follow a fictional patient from booking through a visit, a published result or care plan, a follow-up and a billing entry. Reception should see the operational fields it needs, the clinician should see the private chart, and the patient should see only information shared with them. Record who approved the workflow by role, the date, and which issues remain, using a private clinic record for identifying information. Viewing the demo is already complete. This review becomes relevant when the clinic is preparing for real use.

### 8.2 Optional integrations and wider product ideas

| If the user chooses this scope | Available today | Decisions or engineering still needed |
| --- | --- | --- |
| External messaging and verified contact | In-app activity, local reminder/escalation workers and staff-assisted account recovery. | Choose email/SMS/WhatsApp or push, sender verification, consent, delivery states, retries, cost and monitoring. Build and test the provider adapter before enabling delivery. |
| Payments, video or calendars | Recorded external payments/refunds and corrections, online-visit booking mode and an ICS download. | Choose a gateway and reconciliation rules, a video provider and room-access rules, or calendar synchronization. Each connection needs separate implementation and operational credentials. |
| Clinical decision support, multilingual voice and AI | Structured clinician-reviewed intake, notes, private images and annotations, clinician-entered cautions and an authored knowledge library. | Define a specific use, approved sources, reviewer, data rights, validation and failure handling before scoping implementation. Separate consent purposes and complete internal-record release/retention workflows need clinic decisions and design. |
| Mobile distribution, professional identity, commercial and larger-clinic features | Responsive web portal, doctor profiles, operational module switches and a single-clinic database. | Native packaging/signing, professional review or ranking, subscription billing, hospital/inpatient or pharmacy workflows, research or education tools, campus navigation and multi-clinic isolation each require a separate product choice. Some selectors and historical summaries load substantial data. Size and performance targets should come from the intended workload. |

For a chosen integration, agree on the provider, the exact user journey and how success/failure will be shown. Codex can implement and test locally with synthetic fixtures within that new scope. The owner provides accounts and enables real delivery, credentials, money movement or public access only when ready. [Deferred product areas](../../docs/PRODUCT.md#remaining-substantial-releases) · [Integration boundaries](../../docs/DEPLOYMENT.md#integration-boundaries)

## 9. Runtime and code map

### Runtime

- Use Node **24** for development and CI. The local v1.57 suite ran on **24.22.3**. Built-in `node:sqlite` is used and Node 24 may emit its experimental warning.
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
8. For a command with a retained rejection, record that outcome with no domain effects. If partial effects were attempted, roll them back before storing the rejection. Exact replay of that rejection stays rejected even if conditions later change.
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

## 11. Where to find the latest clinical workflows

Use these entry points when the user identifies a concrete issue in one of the five v1.57 workflows. Staff can recover a submitted intent within the same signed-in tab, and staff-only evidence stays in the clinical workspace. The server keeps the original outcome while current records can continue to change.

| Workflow | Code and expected outcome |
| --- | --- |
| Plan a procedure | `ProcedurePlanModal.tsx`, `server/clinical.ts`, `server/procedure-catalogue.ts`. A clinician can resume a manual or template-based plan with the same request. Recovery retains the original wording, selected template version and visit. Two deliberate matching plans can have separate IDs. |
| Link, change or remove a procedure appointment | `ProcedureAppointmentModal.tsx`, `ProcedureSchedulingPage.tsx`, `server/procedure-scheduling.ts`. Reception and clinical staff see the original link change alongside the current association after a later change. Event, audit and an eligible patient’s notice commit together. |
| Cancel a planned procedure | `ProcedureCancellationModal.tsx`, `server/procedure-cancellation.ts`. The clinician reviews the latest patient decision and linked visit. The original cancellation retains reason, clinician, time and visit. The appointment, reservations, decisions, invoices and payments keep their own histories. |
| Record an investigation review | `InvestigationReviewModal.tsx`, `server/investigation-review-recording.ts`. A clinician can recover the original findings, follow-up, result and publication choice. A private interpretation published later has distinct creation and publication evidence. |
| Hand over an investigation | `InvestigationWorklistPage.tsx`, `server/investigation-worklist.ts`. Staff can resume an assignment with its intended recipient and reason. The original assignment can be recovered after a later handover, while current ownership is shown separately. Patient charts, activity and summaries exclude private handover reasons. |

Frontend components above are under `src/components` and pages under `src/pages`. Inspect `src/components/pending-care-submissions.tsx` for the shared tab-scoped state. A reload or sign-out clears that state. Consult the saved record before re-entering an uncertain submission. Compatibility API callers may receive different response shapes from the newer reviewed forms. [API contracts](../../docs/API.md#investigations-procedure-records-and-amendments) · [Regression and upgrade evidence](../../docs/VERIFICATION.md)

Earlier consultation notes and amendments remain part of the clinical record. Their immutable originals and restricted visibility have a separate API and recovery contract. [Consultation documentation](../../docs/API.md#reviewed-consultation-documentation)

## 12. Running locally and verifying a release

### 12.1 View the local demo

On the same Mac, check the preview before starting another process. The previous viewing session ran in the user's desktop login session with loopback bindings and a separate disposable database. A logout or reboot can end the preview.

```sh
curl --fail --silent http://127.0.0.1:5173/api/health
curl --fail --silent http://127.0.0.1:5173/api/session
```

Look for `status: ok` and `demoMode: true`. Open the login page in a browser and check that **Take a look around** offers **Doctor**, **Reception**, **Patient** and **Admin**. Each button signs into a fictional role. The public homepage is at the same origin under `/`. [Local login](http://127.0.0.1:5173/login)

If the user asks to view it and the preview is down, use Node 24 from the repository root. Run `npm ci` if dependencies are missing. For a new isolated viewing session, use the following in a terminal or background job that stays alive while the user explores.

```sh
preview_dir=$(mktemp -d)
DEMO_MODE=true NODE_ENV=development HOST=127.0.0.1 \
  DATABASE_PATH="$preview_dir/clinic.sqlite" PORT=3001 API_PORT=3001 VITE_PORT=5173 \
  npm run dev
```

If either port already belongs to another process, identify it first or choose another free API/frontend pair and adjust the link. Check the actual page and at least one role dashboard before giving the user the link. Leave the requested viewing session running. The preview and test harnesses have separate database lifecycles. [Demo guide](../../README.md#start-the-demo)

### 12.2 Verify a software change

Start with the affected feature's tests. For substantial releases the established checks are:

```sh
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:production
npm run test:recovery
npm run test:e2e
npm audit --omit=dev --audit-level=low
docker compose config --quiet
```

For a bounded local browser run, for example, `E2E_PROJECT_GROUP=3/11 npm run test:e2e` starts only that group's servers. At v1.57 the 55 projects occupy frontend ports 5183–5237 and API ports 3011–3065. Each project has an isolated synthetic database. Local browser tests use Google Chrome, CI uses Chromium, and the ZIP interoperability test uses Python 3’s standard library. Check the current Playwright configuration if the number of projects changes. [Browser configuration](../../playwright.config.ts)

To check the shipped image locally, build a verification tag and use it for both rehearsals. Docker Desktop on this Mac provides the CLI under `/Applications/Docker.app/Contents/Resources/bin` if the current shell cannot find it.

```sh
docker build -t derma-platform:verify .
npm run test:production -- --image derma-platform:verify
npm run test:recovery -- --image derma-platform:verify
```

The production check uses a loopback port. The recovery check opens a restored synthetic database, checks evidence and retired access, and waits for a fresh authenticator sign-in. An actual restore cutover requires a stopped service, preservation of the old database and sidecars, a verified new file, and operator authorization. Keep the off-site backup and matching MFA-key arrangements for the actual installation distinct from a rehearsal. [Runtime and restore runbook](../../docs/DEPLOYMENT.md)

### 12.3 Preserve verification quality

For a clinical write, exercise a delivered request with a lost reply, an undelivered request, a stale source, navigation away and back, and a currently unauthorized account. Check who can see the saved data and notifications. For work affecting retained history or durable command tables, verify an upgrade from an earlier database and a backup/restore as appropriate. For forms, check keyboard access, 320-pixel layouts, dialogs and retry controls on real rendered screens. Exercise legacy entry points where the change affects them.

For a documentation-only update, verify the links, paths, versions, named UI surfaces, recorded results and internal consistency. A historical test result belongs to the commit that ran it. A push may trigger another CI run on the documentation revision. [Verification workflow](../../.github/workflows/ci.yml)

## 13. Delivering and recording the next approved change

1. Read the current state and identify the requested outcome. For configuration, confirm the intended environment and the owner-approved fields. For engineering, capture a reproducible issue or the acceptance criteria of the explicitly selected feature.
2. Work through existing UI and API entry points. Preserve private access, clinical authorship, compatibility, transaction boundaries and historical records. Use synthetic examples for testing.
3. Verify the result at the level of the change. Close a configuration item when the intended screen or role sees the approved result. Close a code change after appropriate source, test, documentation and release checks. Give the user a concrete result and any remaining decision.
4. Commit a coherent source or documentation change, push the authorized branch and compare its remote head with local Git. Keep clinic databases and operator secrets out of the commit. Update the product version for a product release. A handoff or CI-only update can refer to the existing version.
5. Update sections 1, 7 and 8 here at meaningful checkpoints. Record the date, code or CI reference, what was supplied or approved, what was actually applied or verified, which environment it concerned, and the next outstanding item. Refer to a private operational record for sensitive details. The next person should be able to distinguish a successful demo, a completed rehearsal, an approved clinic policy and a live installation.

## 14. Current stopping point

The planned automation is complete, CI passed, Docker Desktop was installed and tested, and the user has explored the demo. Clinic-specific onboarding is awaiting the user. The first actionable item is the approved public clinic profile. When new information arrives, use the matching step in section 8 and work through what it enables. The wider concept remains available for future user-selected work.

## 15. Ready-to-paste continuation prompt

> Open `dev_ref/ref/AI_CONTINUATION_HANDOFF.md` in the `doctor` repository and reconcile it with the current checkout. Use it as the shared history for Derma. I have already viewed the local demo. At the documented checkpoint the planned automated work is complete and I am waiting until I am ready with clinic inputs. If I provide values or a decision, continue from the matching manual step and verify what you can. If I only ask for status or the demo, give me that. If I report a problem or choose a new feature, finish the authorized work with synthetic tests and update the handoff. Keep the app local unless I explicitly authorize deployment.

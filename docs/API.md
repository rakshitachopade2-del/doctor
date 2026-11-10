# Application contract

All paths below start with `/api`. JSON errors use `{error: string}` and an appropriate HTTP status. List endpoints return arrays unless an object shape is stated. Calendar dates use `YYYY-MM-DD`; schedule times use `HH:mm` in `Asia/Kolkata`. Event timestamps and session expiry values are ISO timestamps.

Requests that change state use JSON. Except for login, registration and recovery-token redemption, they require an authenticated session and the session’s `X-CSRF-Token` header. Browser-origin checks also apply. The session cookie is HTTP-only, uses `SameSite=Lax`, and is secure in production. Roles, account status and patient ownership are enforced by the server, not only the interface.

Core models are in `shared/types.ts`; scheduling, identity, operations, clinical workflows, PDF reports, follow-up reviews and activity models are in `shared/scheduling.ts`, `shared/identity.ts`, `shared/operations.ts`, `shared/clinical.ts`, `shared/documents.ts`, `shared/follow-up.ts` and `shared/activity.ts`.

Demo accounts use `DemoClinic2026!` with `doctor@derma.demo`, `reception@derma.demo`, `patient@derma.demo` and `admin@derma.demo`. Demo records are synthetic and cannot be used as a production database.

## Authentication and account lifecycle

- `GET /session` → `Session` (`user`, optional `csrfToken`, `demoMode`). Account data includes normalized `active` and `mustChangePassword` flags.
- `POST /auth/login {email,password}` → `Session`. Inactive accounts cannot sign in. A temporary-password account receives a restricted session until its password is changed.
- `POST /auth/register {name,email,password,phone,dob,gender}` → `Session`; creates a new patient and patient account. Email and date of birth are required.
- `POST /auth/logout` → `{ok:true}`; ends the current session.
- `POST /auth/password {currentPassword,newPassword}` → `{ok:true}`. Passwords require 12–128 characters, and the new password must differ from the current one. Clears the initial-password requirement, ends other sessions and invalidates outstanding recovery grants.
- `GET /auth/sessions` → `AccountSession[]` for the current account: opaque `id`, `createdAt`, `expiresAt`, `current`, and coarse browser `label`. Sessions expire twelve hours after creation.
- `POST /auth/sessions/revoke-others {}` → `{ok:true,revoked:number}`.
- `DELETE /auth/sessions/:id {}` → `{ok:true}`; only the account’s own sessions can be revoked. Revoking the current session also clears its cookie.
- `GET /accounts?search=&role=` → `ManagedAccount[]` (administrator). Search matches name/email; role is one of `admin`, `doctor`, `receptionist`, `patient`.
- `PATCH /accounts/:id {name?,role?,doctorId?:string|null,active?}` → `ManagedAccount` (administrator). Role, linked-profile or active-status changes revoke all target sessions and recovery grants. A doctor role requires a valid doctor profile; a receptionist cannot have one. Patient/staff conversion and patient relinking are rejected. Self-suspension is rejected, and removing the final active administrator returns `409`.
- `POST /accounts/:id/recovery {identityVerified:true}` → `RecoveryGrant` (`token`, `expiresAt`) (administrator, active target account only). The 64-character token is returned once, stored only as a digest, expires after thirty minutes and replaces any earlier grant for that account. Issuing a grant does not itself end existing sessions.
- `POST /auth/recover {token,password}` → `{ok:true}` (no session or CSRF token required). Redeems a valid grant once, changes the password, clears the initial-password requirement and ends all target-account sessions and recovery grants. It does not sign the account in. Invalid, expired and inactive-account grants use a generic error.

Recovery links are shared manually after the clinic verifies identity. The frontend reads the token from `/recover#token=...` and removes it from the address bar. The server does not send recovery email or SMS. Authentication, password changes and recovery actions are rate-limited.

Restricted temporary-password sessions can change their password, sign out or manage their own sessions. They cannot read private clinic/patient data or perform workspace operations. Public discovery/settings/availability/knowledge reads remain available.

## Administration and public configuration

- `GET /users` → normalized account data (administrator; retained for staff and portal setup).
- `POST /users {name,email,password,role,doctorId?}` → `User` (administrator). Roles are `doctor`, `receptionist` or `admin`; doctors require a profile. New accounts have `active:true` and `mustChangePassword:true`.
- `GET /doctors` → `Doctor[]` (public). Each profile includes its current `appointmentDurationMinutes`.
- `POST /doctors`, `PATCH /doctors/:id` → `Doctor` (administrator; full profile: name, title, qualifications, specialties, experience, fee, bio, languages, optional color).
- `GET /settings` → `ClinicSettings` (public fields only).
- `PATCH /settings` → `ClinicSettings` (administrator; partial clinic fields). Timezone remains `Asia/Kolkata`; module settings cover `intake`, `images` and `followUp`.
- `GET /audit` → `AuditEntry[]` (administrator).
- `GET /health` → `{status:'ok'}`.

Disabling a module pauses its new activity. Existing records remain readable within the usual permissions. The clinic’s public `hours` string is descriptive; bookable hours are configured by scheduling endpoints.

## Availability and appointments

- `GET /scheduling` → `SchedulingData` (`schedules`, `closures`, `timezone`, `bookingWindowDays`) (staff). Includes an effective schedule for every doctor, including defaults.
- `GET /schedules/:doctorId` → `DoctorSchedule` (staff).
- `PUT /schedules/:doctorId {durationMinutes,windows}` → `DoctorSchedule` (administrator, or doctor managing their own profile). `durationMinutes` is `15 | 20 | 30 | 45 | 60`. Each window is `{day,start,end,mode}`: day `0` is Sunday through `6` Saturday, and mode is `in-person | online | both`. Empty windows close all weekly availability. Sessions must not overlap on a day, even across different modes, and each must fit at least one appointment. Saved windows are sorted by day/start.
- `POST /schedule-closures {doctorId,startDate,endDate,startTime,endTime,reason}` → `ScheduleClosure` (administrator, or doctor for their own profile). `doctorId:null` applies to the entire clinic and requires an administrator. Both times `null` mean all day; otherwise the same start/end interval applies on each included date. End date must not precede start date or today. The end time must be later on the same day; overnight intervals are not supported.
- `DELETE /schedule-closures/:id {}` → `{ok:true}` (administrator or the closure’s owning doctor).
- `GET /slots?doctorId=&date=&mode=&excludeAppointmentId=` → available start-time strings. Public reads omit `excludeAppointmentId`; supplying it requires access to that appointment and excludes its current reservation when rescheduling. Optional mode is `in-person` or `online`. Signed-in patients’ own overlapping appointments are also filtered.
- `GET /appointments?date=&doctorId=` → `Appointment[]` (staff or owning patient).
- `POST /appointments {patientId?,doctorId,date,time,mode,reason}` → `Appointment` (staff or owning patient). The server assigns the selected doctor’s current appointment duration.
- `PATCH /appointments/:id {status?,date?,time?,doctorId?,mode?}` → `Appointment`. Rescheduling is allowed only while scheduled and cannot be combined with a non-scheduled status change. Patients may reschedule or cancel their own scheduled appointments. Clinic states follow the allowed transition graph; only clinicians can start or complete a consultation.
- `GET /appointments/:id/calendar` → authorized `.ics` download, using the appointment’s recorded duration and IST start time.

Defaults are Monday–Saturday, 09:00–18:00, thirty-minute appointments and both consultation modes. Configured schedules may use other weekdays and multiple daily sessions. The booking horizon is currently 180 days; past times are never offered. The server checks full interval overlap for doctor and patient inside a transaction, including older appointments of a different length.

A schedule change or closure that invalidates existing future bookings returns `409`, leaving both availability and appointments unchanged. Existing bookings must be rescheduled or cancelled first. Changing a schedule alone preserves their duration; an explicit reschedule uses the selected doctor’s current duration. Legacy appointments without `durationMinutes` are treated as thirty minutes. Removing a closure restores the hours allowed by the weekly schedule.

Temporary-password sessions receive anonymous slot availability: their patient-specific busy periods are not applied, and `excludeAppointmentId` is rejected until password rotation.

## Patient records and care

- `GET /dashboard` → `Dashboard` (staff; receptionist responses exclude clinical follow-up details).
- `GET /patients?search=` → `Patient[]` (staff; receptionist responses contain demographics only).
- `POST /patients {name,email,phone,dob,gender,allergies}` → `Patient` (staff). Walk-in records may use empty email/date of birth; reception cannot enter clinical allergies.
- `GET /patients/:id` → `PatientRecord` (clinician or owning patient; reception denied). Internal encounters are omitted from patient responses.
- `POST /patients/:id/portal-account {email,password,identityVerified:true}` → `User` (administrator). Requires an unlinked patient record and unused email; creates an active account requiring an initial-password change. Existing accounts cannot be relinked through this endpoint.
- `POST /intakes {patientId?,concern,location,duration,symptoms,triggers,previousTreatment,medications,allergies,goals,consent:true}` → `Intake` (owning patient or clinician; intake module must be enabled).
- `POST /encounters {patientId,appointmentId?,history,examination,assessment,investigations,plan}` → `Encounter` (clinician with a linked doctor profile). Notes are immutable; a linked appointment must belong to the same patient.
- `GET /care-plans` → `CarePlan[]` (clinician or owning patient), including effective follow-up status/date, revision and latest review as described below.
- `POST /care-plans {patientId,title,instructions,expectations,warnings,cost,startDate,endDate,followUpDate,medications}` → `CarePlan` (clinician with a linked doctor profile). Each medication has name, instructions, schedule, duration and warnings.
- `PATCH /care-plans/:id {status,expectedRevision?}` → hydrated `CarePlan` (clinician with a linked doctor profile); status is `active` or `completed`. A change appends a factual `source:'status-change'` event and patient notification. It does not clear unreviewed check-ins or record new clinical advice. Repeating the current status creates no additional event. An optional stale revision returns `409`.
- `POST /check-ins {carePlanId,date,adherence,feeling,note}` → `CheckIn` (owning patient, active plan, follow-up module enabled). One per plan/day, updated on repeat; dates must be within the plan and not in the future. Adherence is `taken | partial | missed`; feeling is `better | same | worse`.
- `POST /images {patientId?,caption,category,consent:true,dataUrl}` → `ClinicalImage` (owning patient or clinician; image module enabled). Category is `clinical` or `report`. Private JPEG/PNG/WebP images are limited to 5 MB and checked for a matching file signature.
- `GET /images/:id/file` → private image bytes with ownership checks.
- `GET /messages?patientId=` → `Message[]` (clinician or owning patient).
- `POST /messages {patientId?,body}` → `Message` (clinician or owning patient; follow-up module enabled). Messages have a 4,000-character limit and remain inside the platform.

## Follow-up review and worklist

- `GET /follow-up-worklist?scope=mine|all` → `FollowUpWorkItem[]` (doctor/administrator). Defaults to `mine` for doctors and `all` for administrators. Ownership is the original care-plan doctor; `all` uses the existing clinic-wide clinical permissions. Includes active and completed plans, sorted by due status, unreviewed count, next review date and patient name. Each item contains `carePlan`, `patient`, `ownerDoctorId`, `ownerDoctorName`, `revision`, `latestReview`, `unreviewedCheckIns`, `unreviewedCount` and `due`.
- `GET /care-plans/:id/reviews` → newest-first `FollowUpReview[]` (clinician) or `PatientFollowUpReview[]` (owning patient). Reception is denied. Patient responses omit internal `assessment` and `checkInSnapshots`.
- `POST /care-plans/:id/reviews {expectedRevision,assessment,patientInstructions,disposition,nextReviewDate?}` → hydrated `CarePlan` with `201` (linked clinician; follow-up module enabled). Assessment and patient instructions are required, with an 8,000-character limit each. Disposition is `continue | visit-requested | complete`. Continuing or requesting a visit requires today's date or a future `nextReviewDate`; completion stores `null`. `expectedRevision` must match the current 64-character revision from the plan/worklist. A new review or new/edited check-in makes an earlier revision stale and returns `409` without saving.

Hydrated care plans in plan lists, patient records and dashboard follow-ups include `effectiveStatus`, `effectiveFollowUpDate`, `followUpRevision` and `latestReview`. Their original `startDate`, `endDate` and `followUpDate` remain unchanged. A plan is due when active and its effective review date is today or earlier. The latest event determines active/completed status and the next review date; completed plans have no effective review date. Patient-facing hydration applies the same internal-field filtering as review history.

Each immutable `FollowUpReview` records its ID, plan, linked doctor/name, `source` (`clinical-review | status-change`), assessment, patient instructions, disposition, next review date, timestamp and full check-in snapshots. Each snapshot carries the check-in `id`, `updatedAt`, SHA-256 `contentHash` and original `snapshot`. The snapshot timestamp reflects the check-in's latest stored submission time, including a same-day replacement. The server captures these fields; clients cannot provide or replace them. Current versions not captured by the latest clinical review remain unreviewed. Editing a previously reviewed check-in reopens that work while preserving the exact evidence previously reviewed.

Completing a plan stops check-ins. Continuing follow-up does not extend the original treatment dates or medication duration; `visit-requested` does not book an appointment. A status-only change can reopen a plan but does not count as clinical review. Existing history and the status-only endpoint remain available when the follow-up module is disabled. Check-ins describe patient reports; review queues and dispositions do not diagnose, triage urgency or generate treatment advice.

## In-app activity

- `GET /activity?unread=true|false&limit=&cursor=` → `ActivityFeed` (`items`, `unreadCount`, `nextCursor`). Limit defaults to 30, with a range of 1–100. `unread=true` filters the page; `false` or omission includes read and unread items. The count covers all currently unread items for the recipient, not just the page. Items are newest first. Pass the previous `nextCursor` to load older items; a cursor outside the account's permitted feed returns `400`.
- `POST /activity/:id/read {}` → `ActivityItem`. Only the recipient can mark an item read; an inaccessible item returns `404`. Repeated reads preserve the initial `readAt`.
- `POST /activity/read-all {throughId}` → `{markedRead:number}`. Marks all unread items for the recipient at or before the supplied feed item, including older pages not yet loaded. Use the newest item from the displayed snapshot. Items arriving after that snapshot stay unread; an inaccessible snapshot ID returns `404`.

An `ActivityItem` has `id`, `kind`, `title`, `detail`, `href`, `createdAt` and nullable `readAt`. Kinds are `appointment`, `care-plan`, `message`, `check-in`, `investigation`, `procedure` and `follow-up`. Event contents are immutable; read state is separate. Listing a feed never marks it read, and reading a notification does not mark clinical information reviewed or complete a task.

Feeds are account-specific. Patients see only their own patient notifications; doctors and administrators see their own clinical notifications; reception receives an empty feed. Current account permissions still apply after role changes. Clinical events with an assigned doctor route to active linked accounts for that doctor, falling back to the active clinical team only when no owner account is active. The author is excluded after recipient selection. Patient messages without a specific owner notify the active clinical team. No notification exposes internal assessments, unpublished interpretations or private message text.

Notifications are recorded with the source event in one transaction and deduplicated by recipient/event key. Events notify accounts active at that moment; creating or reactivating an account does not backfill earlier events. These are in-app updates only: no email, SMS, push delivery, background due-date reminders or emergency monitoring is configured.

## Private PDF reports

- `GET /documents?patientId=` → `PatientDocument[]` (doctor/administrator or owning patient; reception denied). Patient accounts default to their own record; clinical staff supply `patientId`.
- `POST /documents {patientId?,title,originalName,dataUrl,consent:true}` → `PatientDocument` with `201`. Accepts canonical base64 `application/pdf` data URLs, up to 5 MB decoded, inside the existing 7 MB JSON request limit. Title and original filename have a 200-character limit. Filenames must end in `.pdf` and contain no path separators or control characters. The server validates PDF header/end markers and records the authenticated uploader, byte count and SHA-256 fingerprint.
- `GET /documents/:id/file` → authorized PDF attachment. The server uses a generated download filename, `Content-Disposition: attachment`, `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

`PatientDocument` contains `id`, `patientId`, `title`, `originalName`, `mimeType:'application/pdf'`, `sizeBytes`, `sha256`, `createdById`, `createdByName`, `createdByRole`, `createdAt`, `url` and `consent:true`. List responses contain metadata, not file bytes. Document metadata and original bytes are immutable; there is no edit/delete endpoint. PDFs use separate storage and routes from the raster image library.

These checks recognize a candidate PDF; they do not sanitize or malware-scan it. Original files are downloaded rather than embedded. The fingerprint identifies the uploaded bytes, not their issuing laboratory or medical accuracy. Upload agreement records private care use and does not authorize public publication.

## Investigations, procedure records and amendments

`GET /patients/:id/clinical-workflows` → `PatientClinicalWorkflows` with `investigations`, `procedures` and `amendments` arrays. Doctors and administrators may inspect the clinic's records; patients receive only their own. Reception is denied. Patient responses contain no internal encounter amendments and omit every unpublished investigation-review object. Top-level arrays are newest first; nested results, reviews and procedure agreements are chronological, so the last entry is the latest.

All clinical authorship below requires an account linked to a doctor profile, including administrators. An unlinked administrator can inspect authorized records but cannot create orders, clinical interpretations, amendments or procedure records. Names, identifiers, roles and timestamps are derived by the server.

### Investigation orders and review

- `POST /investigations {patientId,title,kind,reason,instructions,dueDate?}` → `Investigation` with `201` (linked clinician). Kind is `laboratory | pathology | imaging | other`. Reason and patient-facing instructions are required; optional due date may be `null` or today/a future date. The original order is immutable.
- `POST /investigations/:id/results {note?,documentIds?}` → updated `Investigation` with `201` (owning patient or linked clinician). Requires a note or at least one PDF-report ID. The 0–10 document IDs must be unique and belong to the same patient. Each submission is an immutable `InvestigationResult` with authenticated `submittedById`, name, role and timestamp. Notes and raw reports are patient-visible and remain distinct from clinician interpretation.
- `POST /investigations/:id/reviews {resultId,summary,followUp?,publishToPatient?}` → updated `Investigation` with `201` (linked clinician). The selected result must be the latest submission; a stale selection returns `409`. Summary is required. Publication defaults to `false`; explicit `publishToPatient:true` shares the interpretation. Review text is immutable; subsequent reviews are additional entries.
- `POST /investigations/:id/reviews/:reviewId/publish {}` → updated `Investigation` (linked clinician). Explicitly shares an existing interpretation without changing its content. Repeating the publication preserves its original publication timestamp.
- `POST /investigations/:id/cancel {reason}` → updated `Investigation` (linked clinician). Cancellation preserves history and prevents new results/reviews. A cancelled order or an investigation whose latest result is already reviewed returns `409`.

Investigation status is derived: `ordered` before a result, `result-received` when the latest submission has no review, `reviewed` after a clinician reviews that latest submission, or `cancelled`. A supplemental submission returns the order to `result-received` and retains earlier results and interpretations. A reviewed result may still have no patient-visible interpretation until explicit publication. The application does not classify a result as normal/abnormal or generate a diagnosis.

### Consultation amendments

- `POST /encounters/:id/amendments {reason,text}` → `EncounterAmendment` with `201` (linked clinician). Both fields are required. The server derives the patient from the original encounter and records the amending doctor and timestamp. The original consultation note remains unchanged. Amendments are returned only in the clinician's workflow view and cannot be edited or deleted.

### Procedure discussion and completion

- `POST /procedures {patientId,appointmentId?,title,indication,benefits,risks,alternatives,aftercare,estimatedCost?}` → `ProcedureRecord` with `201` (linked clinician). Discussion fields are required, and estimated cost is descriptive text. An optional linked appointment must belong to the same patient and must not be cancelled or marked as a no-show. A procedure plan is immutable; create a new plan if its explanation changes.
- `POST /procedures/:id/agreements {decision,method,note?,patientDecisionConfirmed?}` → updated `ProcedureRecord` with `201`. Decision is `agreed | declined`. An owning patient uses `method:'portal'`. A linked clinician may record an `in-person` or `phone` decision only with a nonempty discussion note and `patientDecisionConfirmed:true`; clinicians cannot impersonate a portal acknowledgement. Each event retains the actual recording account, role, method and timestamp.
- `POST /procedures/:id/complete {outcome,aftercare}` → updated `ProcedureRecord` (linked clinician). The latest recorded decision must be `agreed`. Completion records the performing doctor and server timestamp and requires outcome and aftercare. If linked to an appointment, that appointment cannot be cancelled/no-show or have a scheduled start time in the future.
- `POST /procedures/:id/cancel {reason}` → updated `ProcedureRecord` (linked clinician).

A procedure starts as `planned`; `completed` and `cancelled` are terminal. Patient decisions can change while planned, and all earlier decisions remain visible. Agreement checks and completion/cancellation run transactionally. Completing or cancelling a procedure neither changes its appointment nor creates a billing charge. No separate procedure time slot is reserved.

These records capture a clinician's explanation and a reported patient decision. They are not an electronic-signature workflow or a certification of legally sufficient informed consent. There is no automatic treatment recommendation, drug-warning validation, laboratory connection or interpretation of report contents. Long clinical text fields have an 8,000-character limit.

## Billing and approved knowledge

- `GET /invoices` → `Invoice[]` (staff or owning patient).
- `POST /invoices {patientId,items:[{description,quantity,unitAmountPaise}],requestId?}` → `Invoice` (staff). Money uses integer paise; optional UUID request ID supports safe replay.
- `GET /invoices/:id` → `{invoice,payments}` (staff or owning patient).
- `POST /invoices/:id/payments {amountPaise,method,reference?,requestId}` → `{invoice,payments}` (staff). UUID request ID is required. Methods are `cash | card | upi | bank`. Identical retries reuse the existing payment without recording another receipt; changed request content and overpayment are rejected. This records a payment received elsewhere; it does not charge a payment provider.
- `GET /knowledge` → published `KnowledgeArticle[]` (public).
- `GET /knowledge/manage` → all `KnowledgeArticle[]` (clinician).
- `POST /knowledge {title,category,body}` → draft `KnowledgeArticle` (clinician).
- `PATCH /knowledge/:id {title?,category?,body?,status?}` → `KnowledgeArticle` (clinician). Edited content becomes draft unless explicitly reapproved with `status:'published'`.

## Frontend structure

Public routes: `/`, `/login`, `/register`, `/recover`, `/library`; authenticated booking: `/book`; patient intake: `/intake`.

Patient routes: `/my-care`, `/my-care/record`, `/my-care/messages`, `/my-care/invoices`, `/my-care/library`, `/my-care/activity`. Staff routes: `/clinic`, `/clinic/appointments`, `/clinic/scheduling`, `/clinic/patients`, `/clinic/billing`. Clinical-only routes: `/clinic/patients/:id`, `/clinic/follow-ups`, `/clinic/knowledge`, `/clinic/activity`. Administrator routes: `/clinic/settings`, `/clinic/accounts`, `/clinic/audit`. Every signed-in role can use `/account`; temporary-password sessions are directed there before entering their workspace.

Shared client helpers in `src/lib.tsx` include `api<T>()`, `useSession()`, `useResource<T>()`, `useToast()`, `today()`, `formatDate()` and `money()`. Shared accessible controls live in `src/components/ui.tsx`; page-specific styles supplement `src/styles.css`.

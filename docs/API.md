# Application contract

All paths below start with `/api`. JSON errors use `{error: string}` and an appropriate HTTP status. List endpoints return arrays unless an object shape is stated. Calendar dates use `YYYY-MM-DD`; schedule times use `HH:mm` in `Asia/Kolkata`. Event timestamps and session expiry values are ISO timestamps.

Requests that change state use JSON. Except for login, registration and recovery-token redemption, they require an authenticated session and the session’s `X-CSRF-Token` header. Browser-origin checks also apply. The session cookie is HTTP-only, uses `SameSite=Lax`, and is secure in production. Roles, account status and patient ownership are enforced by the server, not only the interface.

Core models are in `shared/types.ts`; scheduling, waitlist, identity, operations, clinical workflows, PDF reports, follow-up reviews/assignments and activity models are in `shared/scheduling.ts`, `shared/waitlist.ts`, `shared/identity.ts`, `shared/operations.ts`, `shared/clinical.ts`, `shared/documents.ts`, `shared/follow-up.ts` and `shared/activity.ts`.

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
- `POST /appointments {patientId?,doctorId,date,time,mode,reason,waitlistId?,patientConfirmed?}` → `Appointment` (staff or owning patient). The server assigns the selected doctor’s current appointment duration. Linking `waitlistId` requires `patientConfirmed:true` and the matching patient, doctor, consultation mode and requested date window; normal slot checks still apply.
- `PATCH /appointments/:id {status?,date?,time?,doctorId?,mode?}` → `Appointment`. Rescheduling is allowed only while scheduled and cannot be combined with a non-scheduled status change. Patients may reschedule or cancel their own scheduled appointments. Clinic states follow the allowed transition graph; only clinicians can start or complete a consultation.
- `GET /appointments/:id/calendar` → authorized `.ics` download, using the appointment’s recorded duration and IST start time.

Defaults are Monday–Saturday, 09:00–18:00, thirty-minute appointments and both consultation modes. Configured schedules may use other weekdays and multiple daily sessions. The booking horizon is currently 180 days; past times are never offered. The server checks full interval overlap for doctor and patient inside a transaction, including older appointments of a different length.

A schedule change or closure that invalidates existing future bookings returns `409`, leaving both availability and appointments unchanged. Existing bookings must be rescheduled or cancelled first. Changing a schedule alone preserves their duration; an explicit reschedule uses the selected doctor’s current duration. Legacy appointments without `durationMinutes` are treated as thirty minutes. Removing a closure restores the hours allowed by the weekly schedule.

Temporary-password sessions receive anonymous slot availability: their patient-specific busy periods are not applied, and `excludeAppointmentId` is rejected until password rotation.

## Appointment waitlist

- `GET /waitlist?status=&doctorId=` → `WaitlistEntry[]` (staff or owning patient). Optional status is `waiting | booked | cancelled | expired`. Staff can see all clinic requests and operational `patientPhone`; patients receive only their own requests without that phone field.
- `POST /waitlist {patientId?,doctorId,mode,startDate,endDate,reason}` → `WaitlistEntry` with `201`. Staff supply a patient; patient accounts use their own linkage and cannot substitute another patient. Mode is `in-person | online`; reason requires 1–300 characters. The inclusive ordered date window must be within today through 180 days ahead. A second waiting request for the same patient, doctor and mode returns `409`, even if its date window differs.
- `POST /waitlist/:id/cancel {reason?}` → `WaitlistEntry` (staff or owning patient). The optional reason has a 300-character limit. Cancelling a waiting request preserves its original record. Repeating cancellation returns the existing result and retains the first reason; booked or expired requests return `409`.

Each entry contains patient/doctor IDs and names, mode, date window, reason, creation time, derived status, nullable `appointmentId`, `closedAt` and `cancellationReason`. Expiry is derived when the end date precedes the current clinic date; no background job or expiry notification is required. Joining does not reserve a slot, prioritize urgency, offer an appointment automatically or send external messages.

Booking uses the ordinary `POST /appointments` endpoint with the request ID and explicit patient confirmation. The appointment, terminal waitlist record, audit and in-app notification commit atomically. An already booked, cancelled or expired request cannot be booked again. Later rescheduling or cancelling the appointment preserves the request's booked history; a separate new request can be created. Staff coordinate patient contact separately, and patients can choose an available slot from their own request.

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

- `GET /follow-up-worklist?scope=mine|all` → `FollowUpWorkItem[]` (doctor/administrator). Defaults to `mine` for doctors and `all` for administrators. Ownership starts with the original care-plan doctor and follows the latest assignment; `all` uses the existing clinic-wide clinical permissions. Includes active and completed plans, sorted by due status, unreviewed count, next review date and patient name. Each item contains `carePlan`, `patient`, `ownerDoctorId`, `ownerDoctorName`, `revision`, `latestReview`, `unreviewedCheckIns`, `unreviewedCount` and `due`.
- `GET /care-plans/:id/reviews` → newest-first `FollowUpReview[]` (clinician) or `PatientFollowUpReview[]` (owning patient). Reception is denied. Patient responses omit internal `assessment` and `checkInSnapshots`.
- `POST /care-plans/:id/reviews {expectedRevision,assessment,patientInstructions,disposition,nextReviewDate?}` → hydrated `CarePlan` with `201` (linked clinician; follow-up module enabled). Assessment and patient instructions are required, with an 8,000-character limit each. Disposition is `continue | visit-requested | complete`. Continuing or requesting a visit requires today's date or a future `nextReviewDate`; completion stores `null`. `expectedRevision` must match the current 64-character revision from the plan/worklist. A new review, assignment or new/edited check-in makes an earlier revision stale and returns `409` without saving.
- `GET /follow-up-owners` → `FollowUpOwner[]` (doctor/administrator): `doctorId`, `doctorName` and `activeAccounts`. Eligible profiles have at least one active linked doctor/administrator account; an account still requiring its initial password change counts as active.
- `GET /care-plans/:id/assignments` → newest-first `FollowUpAssignment[]` (doctor/administrator; patients and reception denied). Each event records the previous/new doctor IDs and names, reason, assigning account ID/name and creation time.
- `POST /care-plans/:id/assignment {doctorId,reason,expectedRevision}` → hydrated `CarePlan` with `201`. Administrators, including those without a doctor profile, can reassign; a doctor must be the current follow-up owner. The handover reason requires 1–8,000 characters and the current 64-character revision is mandatory. An ineligible target returns `400`; the current owner as target or a stale revision returns `409`.

Assignment changes the worklist owner and routing for subsequent check-in notifications, preserving original plan/review authorship. Assignment history and reasons remain clinician-only; patient hydration includes only an opaque changed revision. Reassignment records an immutable event, audit and generic new-owner notification together. It does not clear unreviewed reports or revise treatment. Operational reassignment remains available when the follow-up module is paused.

Hydrated care plans in plan lists, patient records and dashboard follow-ups include `effectiveStatus`, `effectiveFollowUpDate`, `followUpRevision` and `latestReview`. Their original `startDate`, `endDate` and `followUpDate` remain unchanged. A plan is due when active and its effective review date is today or earlier. The latest event determines active/completed status and the next review date; completed plans have no effective review date. Patient-facing hydration applies the same internal-field filtering as review history.

Each immutable `FollowUpReview` records its ID, plan, linked doctor/name, `source` (`clinical-review | status-change`), assessment, patient instructions, disposition, next review date, timestamp and full check-in snapshots. Each snapshot carries the check-in `id`, `updatedAt`, SHA-256 `contentHash` and original `snapshot`. The snapshot timestamp reflects the check-in's latest stored submission time, including a same-day replacement. The server captures these fields; clients cannot provide or replace them. Current versions not captured by the latest clinical review remain unreviewed. Editing a previously reviewed check-in reopens that work while preserving the exact evidence previously reviewed.

Completing a plan stops check-ins. Continuing follow-up does not extend the original treatment dates or medication duration; `visit-requested` does not book an appointment. A status-only change can reopen a plan but does not count as clinical review. Existing history and the status-only endpoint remain available when the follow-up module is disabled. Check-ins describe patient reports; review queues and dispositions do not diagnose, triage urgency or generate treatment advice.

## In-app activity

- `GET /activity?unread=true|false&limit=&cursor=` → `ActivityFeed` (`items`, `unreadCount`, `nextCursor`). Limit defaults to 30, with a range of 1–100. `unread=true` filters the page; `false` or omission includes read and unread items. The count covers all currently unread items for the recipient, not just the page. Items are newest first. Pass the previous `nextCursor` to load older items; a cursor outside the account's permitted feed returns `400`.
- `POST /activity/:id/read {}` → `ActivityItem`. Only the recipient can mark an item read; an inaccessible item returns `404`. Repeated reads preserve the initial `readAt`.
- `POST /activity/read-all {throughId}` → `{markedRead:number}`. Marks all unread items for the recipient at or before the supplied feed item, including older pages not yet loaded. Use the newest item from the displayed snapshot. Items arriving after that snapshot stay unread; an inaccessible snapshot ID returns `404`.

An `ActivityItem` has `id`, `kind`, `title`, `detail`, `href`, `createdAt` and nullable `readAt`. Kinds are `appointment`, `care-plan`, `message`, `check-in`, `investigation`, `procedure`, `follow-up`, `waitlist`, `billing` and `image-annotation`. Waitlist creation/cancellation/booking, follow-up handover, invoice creation and recorded payments generate supported in-app events. A waitlist booking sends one request-specific booking notification, without duplicating the ordinary appointment-created notification. Event contents are immutable; read state is separate. Listing a feed never marks it read, and reading a notification does not mark clinical information reviewed or complete a task.

Feeds are account-specific. Patients see only their own patient notifications; doctors and administrators see their own clinical notifications; reception receives an empty feed. Current account permissions still apply after role changes. Clinical events with an assigned doctor route to active linked accounts for that doctor, falling back to the active clinical team only when no owner account is active. The author is excluded after recipient selection. Patient messages without a specific owner notify the active clinical team. No notification exposes internal assessments, unpublished interpretations or private message text.

Notifications are recorded with the source event in one transaction and deduplicated by recipient/event key. Events notify accounts active at that moment; creating or reactivating an account does not backfill earlier events. These are in-app updates only: no email, SMS, push delivery, background due-date reminders or emergency monitoring is configured.

## Image annotations and patient-facing summaries

- `GET /images/:id/annotations` → `ImageAnnotationHistory` (`imageId`, `revision`, `versions`). Clinical staff receive all revisions with a SHA-256 optimistic revision token. Owning patients receive published revisions only and `revision:null`; no private revision IDs, notes or counts are exposed. Reception is denied. Versions are newest first.
- `POST /images/:id/annotations {expectedRevision,note,markers}` → updated history with `201` (linked clinician). A nonempty note or at least one marker is required. Notes allow up to 4,000 characters; at most 50 markers are accepted. New versions are always private, retain clinical authorship/date and the original image fingerprint, and never change image bytes. The current revision is checked transactionally; stale saves return `409`.
- `POST /images/:id/annotations/:versionId/publish {expectedRevision,patientSharingConfirmed:true}` → updated history (linked clinician). Newly sharing requires the current revision and latest saved version. Repeating a previously completed publication preserves its original timestamp and notification. Explicit publication, audit and a generic patient activity entry save in one transaction. There is no edit/delete/unpublish endpoint.

Each marker has a unique UUID `id`, a color from `red | amber | green | blue | purple | white`, and an optional label up to 200 characters. Rectangle/ellipse markers have `type`, `x`, `y`, `width`, `height`; arrow markers have `type:'arrow'`, `x1`, `y1`, `x2`, `y2`. All coordinates are image-relative values from 0 to 1, rounded to six decimal places. Box dimensions must stay positive and entirely within the image. Arrow endpoints must differ. Arbitrary geometry fields, SVG markup, colors and client-authored provenance are rejected. Coordinates describe position, not physical measurements or automated clinical interpretation.

The image module must be enabled to save or publish. Existing history remains readable while paused. Original image rows, annotation versions and publication events are immutable. New image uploads record authenticated uploader metadata, byte count and SHA-256; legacy uploads retain absent provenance rather than fabricated authorship. Upload plus audit is transactional.

- `GET /patients/:id/care-summary` → `CareSummary` (`schemaVersion:1`, `audience:'patient'`, `generatedAt`, `timezone:'Asia/Kolkata'`, `revision`, clinic contact, patient, appointments, intakes, care plans with patient-facing review history, check-ins, investigations, procedures, image metadata/published annotations, PDF metadata and invoices). Patients may access only their own summary; clinical staff may access the clinic's patients. Reception is denied. Both eligible role groups receive the same patient-facing projection.
- `GET /patients/:id/care-summary/download?revision=` → private JSON attachment. The required 64-character revision must match the current patient-visible content; stale requests return `409` and require a refresh. The export can have a later generation timestamp but must have the same content revision. Filename uses an opaque identifier rather than the patient's name. Responses use no-store and nosniff headers, with authorization and audit on every request.

Summaries exclude internal encounters/amendments, private messages, clinician follow-up assessments/report snapshots/assignment reasons, unpublished investigation interpretations, private image annotations and original file bytes. Attachment URLs remain private authenticated routes. Private drafts and operational handovers do not invalidate a summary unless patient-visible content actually changes. Original regimen dates and instructions remain distinct from later shared follow-up reviews. Printing keeps the displayed snapshot; this is a patient-facing summary rather than a complete internal clinical-record release.

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
- `GET /procedure-billing?patientId=` → `ProcedureBillingItem[]` (staff; patient accounts denied). Returns only `id`, `patientId`, `patientName`, `title`, `estimatedCost`, `status`, nullable `invoiceId` and `invoiceNumber`. Clinical indication, risks, benefits, alternatives, aftercare, decisions and outcomes are omitted; reception cannot fetch the full clinical record.
- `POST /invoices {patientId,items:[{description,quantity,unitAmountPaise}],requestId?,procedureId?}` → `Invoice` with `201` (staff). Money uses integer paise. Optional UUID request ID supports identical replay with `200`; changed patient, procedure or line items under that ID return `409`. Quantities are integers from 1–1,000; unit amounts are positive integers; total invoice value is capped at 1,000,000,000 paise. Totals and initial unpaid status are server-derived.
- `GET /invoices/:id` → `{invoice,payments}` (staff or owning patient).
- `POST /invoices/:id/payments {amountPaise,method,reference?,requestId}` → `{invoice,payments}` (staff). UUID request ID is required. Methods are `cash | card | upi | bank`. Identical retries reuse the existing payment without recording another receipt; changed request content and overpayment are rejected. This records a payment received elsewhere; it does not charge a payment provider.
- `GET /knowledge` → published `KnowledgeArticle[]` (public).
- `GET /knowledge/manage` → all `KnowledgeArticle[]` (clinician).
- `POST /knowledge {title,category,body}` → draft `KnowledgeArticle` (clinician).
- `PATCH /knowledge/:id {title?,category?,body?,status?}` → `KnowledgeArticle` (clinician). Edited content becomes draft unless explicitly reapproved with `status:'published'`.

A procedure can have one linked invoice. It must belong to the invoice patient and must not be cancelled when linking a new invoice. An existing link returns `409` for another creation request; the UI opens its existing invoice. Matching retries reuse the original invoice even if the procedure was subsequently cancelled. Linked invoices include `procedureId` and the original `procedureTitle` snapshot. Linking is immutable and commits with invoice creation, sequence allocation, audit and patient activity.

Procedure estimates never populate a charge automatically: staff enter the agreed line items and amounts explicitly. Planning/completing a procedure does not create an invoice; creating an invoice does not record a payment. Cancelling a procedure does not change an existing charge or create a refund. Payment collection, refunds, tax calculation and external reconciliation require separate clinic processes.

## Administrator expenses and clinic reports

All endpoints in this section require an active administrator session. Other roles are denied, including doctors and reception. Reads and CSV downloads use the same authorization and `Cache-Control: no-store`.

- `GET /expenses?from=&to=&category=&status=` → `ClinicExpense[]`, ordered by incurred date newest first. Required `from` and `to` are real `YYYY-MM-DD` dates, ordered with at most 366 inclusive days. Optional status is `recorded | voided`; omission includes both. Optional category is one of `supplies | equipment | rent | utilities | staff | services | other`.
- `POST /expenses {incurredDate,category,description,amountPaise,reference?,requestId}` → `ClinicExpense` with `201`; an identical retry returns the original with `200`. `requestId` is a required UUID; reusing it with changed normalized fields returns `409`. Amount is an integer from 1 to 1,000,000,000 paise. Description requires 1–300 characters; reference allows up to 200. The incurred date must be a real calendar date and cannot be in the future relative to Asia/Kolkata. Authorship and recording time come from the server.
- `POST /expenses/:id/void {reason}` → updated `ClinicExpense`. The required reason has a 1–1,000 character limit. An identical repeated void returns the existing history; a different reason after voiding returns `409`. The original entry is never changed or deleted. Recording and voiding each commit with their audit entry.
- `GET /insights?from=&to=` → `ClinicInsights`. Uses the same required date range and 366-day limit; future reporting dates are allowed to inspect scheduled appointments. Includes `totals`, `appointmentsByStatus`, `appointmentsByMode`, `expensesByCategory`, `collectionsByMethod` and ascending zero-filled `daily` rows, with `timezone:'Asia/Kolkata'` and `generatedAt`.
- `GET /insights/export?from=&to=` → an authenticated CSV attachment generated from the same aggregation function. Columns are `section,date,metric,dimension,count,amountPaise`. CSV escaping protects quoted content and formula-like prefixes. Exports omit patient identities, account names, individual expense descriptions and references.

`ClinicExpense` preserves the request ID, original amount/category/date/description/reference, creating account ID/name and timestamp. It adds derived `status` and nullable `void` containing the immutable void ID, reason, recording account and date. There is no edit, delete, automatic replacement, payment initiation or bank-reversal operation.

Report appointment counts use the scheduled date and current status; distinct patients include all matching appointments, including cancellations/no-shows. Invoices use their issue timestamp converted to clinic date. Collections use payment recording timestamps, which may relate to invoices issued outside the selected range; actual external receipt dates are not separately stored. Expenses use their incurred date and exclude currently voided entries. `issuedInvoiceOutstandingPaise` is the current unpaid balance on invoices issued in the range, not an as-of historical balance. Reports do not infer profit, tax, clinical outcomes or observed treatment adherence. JSON and CSV are separate current snapshots; data can change between requests.

## Patient details and allergy corrections

- `GET /patients/:id/profile` → `PatientProfile {patientId,demographics,revision,changes}`. All staff may read demographic history and editing revision. Patients may read only their own current demographics, with `revision:null` and `changes:[]`. The response never includes allergy fields or allergy-derived revisions.
- `PATCH /patients/:id/profile` accepts full `{name,email,phone,dob,gender,reason,expectedRevision,requestId}` from staff. Name1–300, email valid or empty (max254), phone7–30, DOB real nonfuture date or empty, gender0–50, reason1–1000. Whitespace is trimmed and email lowercased. Returns current `PatientProfile`. Each changed record preserves prior/current demographic values, staff identity, reason and timestamp. Reasons are staff-only. Empty or unchanged corrections return400.
- `GET /patients/:id/allergies` → `PatientAllergyHistory {patientId,current:{status,text},revision,changes}` for clinicians or the owning patient. Patients receive null revision; reception is denied. Safe changes include before/after status/text, shared reason, doctor ID/name and timestamp, without account IDs or request IDs.
- `POST /patients/:id/allergies` requires a linked clinician and `{status,text,reason,expectedRevision,requestId}`. Status is `not-recorded`, `none-known` or `recorded`; text is1–8000 characters for `recorded` and empty otherwise. The reason (1–1000) is explicitly shared with the patient. Returns current history; unchanged clinical values return400.

Both write families require a UUID and current64hex revision, use separate revision streams, and support exact actor-bound replay before stale/no-op checks. Reusing a correction key across actors, patients, operations or normalized payloads conflicts. Current patient changes, immutable events, request receipts and audit commit in one transaction. Concurrent changes in the same stream return409, while a demographic correction does not invalidate an allergy editing token or reveal that token to reception.

The current Patient projection adds `allergyStatus`; nonempty legacy allergy text maps to `recorded`, otherwise `not-recorded`, unless an explicit later clinician event states `none-known`. No legacy author or verification event is invented. Reception projections omit the status and retain empty `allergies` only for backward compatibility. These core corrections remain available when optional modules are paused. Login names/emails, account linkage, and historical patient-name snapshots in appointments, notes, plans and invoices remain unchanged. Patient-facing care summaries include current details/status and safe `allergyHistory`, but exclude demographic correction history and reasons.

## Consumable inventory

All inventory routes allow staff reads (`admin`, `doctor`, `receptionist`) and administrator mutations. Patients and temporary-password sessions cannot access inventory. No operation creates a charge, expense, prescription or patient association.

- `GET /inventory/items?search=&active=true|false|all&stock=low|expired|expiring-soon` → `InventoryItem[]`; active items by default. Search matches the catalogue; stock filters select items with the corresponding condition.
- `GET /inventory/items/:id` → `InventoryDetail {item,lots,itemChanges}`. Includes immutable catalogue snapshots with author, reason and date, newest first.
- `GET /inventory/items/:id/movements?limit=&cursor=` → `InventoryLedger {items,nextCursor}`; newest first, default 50 and maximum 100. Cursors are opaque movement IDs scoped to the item.
- `POST /inventory/items` accepts `{sku,name,category,unit,reorderLevel,requestId}` → `201 InventoryDetail`; an exact retry returns `200`.
- `PATCH /inventory/items/:id` accepts `{name?,category?,reorderLevel?,active?,reason,expectedRevision,requestId}` → `InventoryDetail`. SKU and unit are immutable. Edits retain an attributed catalogue snapshot; archive/reactivation preserve all stock history.
- `POST /inventory/items/:id/receipts` accepts `{quantity,lotCode?,expiryDate,reason,reference?,expectedRevision,requestId}` → `201 InventoryMutation {detail,movement}`. `expiryDate` is an exact calendar date or `null`. Every receipt creates its own immutable lot, even when supplier lot labels repeat.
- `POST /inventory/lots/:id/use` accepts `{quantity,reason,reference?,expectedRevision,requestId}` → `InventoryMutation`. The item must be active, the lot must not be expired, and sufficient stock must remain.
- `POST /inventory/lots/:id/adjust` accepts `{countedQuantity,reason,reference?,expectedRevision,requestId}` → `InventoryMutation`. It records the observed whole-unit balance, deriving the signed adjustment from the current lot balance. A zero adjustment still records the count. Inactive and expired lots can be reconciled.

Categories are `dressings`, `protective-equipment`, `instruments`, `cleaning`, `office`, `other`. Units are `piece`, `pair`, `pack`, `box`, `bottle`; they count whole units without conversions. SKU is normalized uppercase, 1–50 characters: a leading letter/digit followed by letters, digits, periods, underscores or hyphens. Names are 1–150 characters; lot codes up to 100; reasons 1–1000; references up to 200. Receipt/use quantity is an integer from 1 to 1,000,000. Counts and lot/item balances are bounded from 0 to 1,000,000,000; reorder thresholds from 0 to 1,000,000.

`InventoryItem` exposes on-hand, unexpired, expired and expiring-soon quantities, a low-stock flag and a revision. A lot is expired when its recorded expiry date is before today's Asia/Kolkata date. Expiring soon covers today through 30 days ahead, inclusive. Unknown expiry is explicitly `null`; it contributes to unexpired quantity without claiming suitability for use. Low stock means an active item's unexpired balance is at or below its reorder threshold. Already-expired receipts may document existing physical stock but cannot subsequently be used.

Stock balances derive from immutable movements; `balanceAfter` is the recorded balance of that lot after the event, not a current balance or item total. Catalogue originals, changes, lot metadata and movements are retained. Revisions include catalogue/stock changes and the clinic date, so a day rollover requires refresh before a new stock operation. Global request UUIDs are bound to the actor, operation and normalized business payload. Exact retries resolve before revision checks and return the original event with current detail; reusing a key for different input or an account conflicts. Revision/balance checks, source events, request receipts and audit entries commit in one transaction. Failed audits do not leave partial stock changes.

## Frontend structure

Public routes: `/`, `/login`, `/register`, `/recover`, `/library`; authenticated booking: `/book`; patient intake: `/intake`.

Patient routes: `/my-care`, `/my-care/record`, `/my-care/messages`, `/my-care/invoices`, `/my-care/library`, `/my-care/activity`, `/my-care/summary`, `/my-care/details`. Staff routes: `/clinic`, `/clinic/appointments`, `/clinic/scheduling`, `/clinic/waitlist`, `/clinic/patients`, `/clinic/billing`, `/clinic/inventory`, `/clinic/patients/:id/details`. Clinical-only routes: `/clinic/patients/:id`, `/clinic/patients/:id/summary`, `/clinic/follow-ups`, `/clinic/knowledge`, `/clinic/activity`. Administrator routes: `/clinic/settings`, `/clinic/accounts`, `/clinic/audit`, `/clinic/insights`, `/clinic/expenses`. Inventory selection uses `/clinic/inventory?item=id` with `view=lots|movements|changes`. Every signed-in role can use `/account`; temporary-password sessions are directed there before entering their workspace.

Patient waitlist links use `/my-care?waitlist=id`; booking from a request uses `/book?waitlist=id` with a fixed clinician/mode and constrained date window. `/my-care?plan=id` reveals the selected active or completed plan. Record sections accept `?tab=careplans`, `workflows`, `images` or `visits`. Procedure billing uses `/clinic/billing?procedure=id`; invoice links use `?invoice=id` on the staff or patient invoice route.

Shared client helpers in `src/lib.tsx` include `api<T>()`, `useSession()`, `useResource<T>()`, `useToast()`, `today()`, `formatDate()` and `money()`. Shared accessible controls live in `src/components/ui.tsx`; page-specific styles supplement `src/styles.css`.

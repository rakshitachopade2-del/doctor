# Running a clinic installation

Use Node.js 24 and one application instance per database. This release is for a **single clinic**: clinicians can access all clinical records in that clinic, reception can manage demographics, appointments and billing, and patients can access only their own patient-facing records. It is not a multi-tenant service. Node 24 currently labels its built-in SQLite API experimental.

## Prepare a fresh production database

Install, build, and copy the environment template:

```sh
npm ci
npm run build
cp .env.example .env
```

Set these values in `.env` for a local service behind a TLS reverse proxy:

```dotenv
DATABASE_PATH=data/production.sqlite
DEMO_MODE=false
HOST=127.0.0.1
PORT=3001
APP_ORIGIN=https://clinic.example.com
TRUST_PROXY=false
```

Use a real HTTPS origin without a trailing slash. `npm start` forces production mode, including Secure session cookies and rejection of demo databases. A plain HTTP browser connection cannot maintain a production sign-in. `npm run dev` is for local development; it must not be exposed as the production service.

Production starts without doctor profiles, patient records or demo accounts. Bootstrap the administrator with a new database path. The following uses **Bash**, reads the password without echo, and passes it through standard input rather than a command argument or literal shell history entry:

```bash
read -r -s -p 'Initial administrator password (12+ characters): ' derma_admin_password
printf '\n'
printf '%s\n' "$derma_admin_password" | ADMIN_EMAIL='admin@example.com' ADMIN_NAME='Clinic administrator' npm run create-admin
unset derma_admin_password
npm start
```

Sign in over HTTPS. Configure clinic details, create doctor profiles, and add individual staff accounts in **Clinic settings → Your team**. Clinical notes and care plans must be authored from an account linked to a doctor profile. The bootstrap administrator has no doctor identity; create a doctor profile and a separate linked doctor account before documenting care, or explicitly link an appropriate profile through **Accounts & access**.

Existing walk-in records can receive portal accounts only after an administrator confirms the patient’s identity and email. Accounts are never automatically linked by matching email. Staff and portal accounts created through the clinic interface must change their initial password in **Account & security** before accessing private records. The administrator created with the bootstrap CLI uses the private password supplied through stdin and is not forced through this initial-password step.

Configure each doctor in **Availability & time off** before opening bookings. New and existing profiles without a saved schedule default to Monday–Saturday, 09:00–18:00 with 30-minute appointments. Choose weekly sessions, consultation mode per session, and a 15/20/30/45/60-minute duration; add breaks by splitting a day into sessions. Administrators can add whole-clinic holidays, and linked doctors can manage their own availability and time off. Reception has read-only access. Schedule changes that conflict with existing future appointments are rejected; arrange the affected visits first.

A database seeded in demo mode is deliberately rejected by production. Keep demo and production databases separate; importing fictional records is not a production migration.

Clinic details and care modules use independent forms in Clinic settings. Each reviewed change needs a private reason; use Configuration history to inspect retained before/after values. Review current values after a stale edit, and use the pending request's retry after an uncertain response. Public hours are descriptive; configure bookable hours separately under Scheduling.

## Upgrade an existing installation

Create and verify a backup before replacing the running application. Stop the service, install the new dependencies, build, and restart against the same production database. Startup creates the scheduling, recovery, clinical workflow, private PDF, follow-up review/assignment, waitlist, procedure-invoice link, expense, image annotation/publication, inventory, patient-detail/allergy correction, billing-correction/reversal, investigation handover/command and activity tables and adds session metadata where needed. Existing users retain their current access; the mandatory-password rule applies to newly provisioned accounts. Existing doctor profiles retain the original default hours until an authorized user saves another schedule. Previously booked appointments without a stored duration continue to count as 30 minutes.

Knowledge authoring adds private, immutable content versions, change events and retry receipts automatically. Startup imports retained article snapshots and current content without changing existing publication status or public URLs. Legacy snapshots show their recorded labels and dates; they do not invent a saving account or publication approval. No external service or manual migration is required. New changes record their actual author and review. Saving or restoring a draft withdraws the article from public readers until it is explicitly approved again; restoring creates a new version and keeps the original history.

Clinic configuration adds empty immutable change and command tables automatically. Existing contact details and module values remain intact, with no invented earlier history or author. Subsequent reviewed changes record a private reason; compatibility settings writes are identified as legacy events. The ordinary SQLite backup retains this history and retry receipts. No provider or manual migration is required.

Recurring appointment series add immutable booking origins and retry receipts automatically. Existing appointments are unchanged and are not assigned invented series membership. Staff can book a finite set using the clinic's existing schedules; no background recurrence job, external calendar or additional configuration is required. Backups retain series origins, original visit snapshots and private booking notes alongside the ordinary appointment records.

Series cancellation adds an empty append-only event table and reuses the existing series command receipts. Earlier individual cancellations are not reconstructed as batch history. The same SQLite backup retains cancellation snapshots, private reasons, resource release history and receipts. No migration command, provider, background task or new configuration is required.

Series rescheduling adds a separate empty append-only event table and shares the existing series command receipts. Existing appointment dates and earlier individual moves remain untouched; no batch history is fabricated. Backups retain private before/after move history and resource allocation evidence. No external calendar, provider, background job or additional configuration is required.

Saved care-summary copies and their immutable retry receipts start empty on upgrade. Only explicit saves create copies; earlier views and downloads are not reconstructed. Copies are stored in the same SQLite database and included in its backups, with a 10 MiB limit per copy. No provider, configuration or separate file store is needed. Copies persist until a separately governed retention process is implemented; this release adds no deletion or purge operation.

Existing notes, plans, appointments, reports and images remain intact. The `followUpReviews` table preserves append-only clinician reviews and status changes, including the check-in versions reviewed at that time. New reviews can set an effective next review date or complete a plan without changing its original medication instructions or regimen dates. Patients receive the shared instructions and dated review history; internal assessments and check-in snapshots remain available only to clinicians. Previously completed plans remain completed without fabricated review entries.

Waitlist requests, follow-up assignments, procedure-invoice links and expense entries start empty on upgrade. Existing plans keep their original author as follow-up owner until an explicit handover. Existing invoices are not retroactively linked to procedures. Expense corrections use attributed void events; originals remain in the database and backups. Image originals become immutable, and new uploads retain uploader identity, byte count and SHA-256 fingerprint. Legacy image uploader fields stay absent; annotation revisions can still identify the existing file bytes without inventing authorship. Existing images start without annotation/publication history. Patient correction histories also start empty: existing allergy text is retained without invented review history, and empty text remains not recorded unless a clinician explicitly updates it. Corrections preserve account login identity and older document snapshots. The inventory catalogue, lots and movements also start empty; administrators record known physical stock explicitly. Whole-unit stock events and catalogue snapshots are included in the same database backup.

Billing corrections preserve the original issued charges before the first correction. Existing invoice and payment history is not backfilled with invented corrections; operational balances stay unchanged until an explicit action. Mistaken-entry reversals retain source payments and alter current reporting, without issuing real refunds.

Investigation worklists derive from existing orders and results; no historical review or handover is invented. Existing orders remain assigned to their original clinician until an explicit transfer. New handover and review-command tables preserve source revisions and replay receipts in the same database backup. Private handovers do not add information to patient-facing records. Existing API callers that omit both review tokens remain compatible; application review forms now use both revision and retry UUID.

The `activity` table preserves notification contents and recipient ownership; only read status can change. The inbox starts empty after an upgrade and records supported events that occur afterward. It does not reconstruct notifications from existing records or send historical updates to newly created accounts. Clinical records remain the source of truth. Marking activity read does not record a clinician review, book a visit, or change treatment.

The procedure catalogue also starts empty on upgrade. Its current projection, immutable content versions, publication/availability history and retry receipts are included in the database backup. Existing procedure plans retain their original wording without invented template provenance. No catalogue examples or medical wording are automatically seeded. Linked clinicians explicitly author and publish templates in the application; no new environment variable or provider is required.

After restart, confirm account access and review each doctor’s actual hours and planned closures. An upgrade does not automatically reschedule, cancel, or notify patients. Keep the pre-upgrade backup so application code and database state can be restored together if rollback is required.

Saved-summary attachment bundles need no provider, environment setting or migration. They are generated in memory from existing immutable copies and original image/report BLOBs, with at most 20 attachments, 5 MiB per original and 25 MiB for the complete ZIP. No archive is saved on the server. Existing database backups already contain the required copies and originals. The ordinary JSON export remains available for a copy whose selected originals cannot be bundled. Downloaded archives are unencrypted and outside application access control after download.

## Follow-up escalation operation

Escalation policy, command, run and notice tables are additive and begin empty on upgrade. The policy starts disabled with thresholds of 3/7 overdue calendar days. An administrator can enable it in **Follow-up care → Escalation policy** after reviewing a preview. Existing active overdue plans then become eligible for new notices; no past notice is invented. Policy changes and notice history are included in the SQLite backup.

The server checks at startup and every 15 minutes. Set `FOLLOW_UP_ESCALATION_AUTO=false` for manual-only checks; this does not change the saved policy. A process shutdown stops its timer. Startup catches up from current plan state and retained dedupe history. Each run creates notices for at most 200 plans, oldest first; the preview shows the remaining eligible backlog. Pausing the follow-up module or disabling the policy prevents new notices. Plans without eligible clinician recipients remain eligible for future checks. The policy view reports whether this process runs automatic checks and the last check/error time. A recorded notice is in-app activity, not proof of clinical review or delivery to an external device.

## Appointment reminder operation

Appointment reminder tables and command receipts are created empty on upgrade. The saved policy starts disabled with a 24-hour lead window. Administrators can configure 1–168 hours in **Appointments → Appointment reminders**; staff can inspect operational previews and history. Enabling the policy permits upcoming eligible existing bookings to receive a new notice, but does not backfill past appointments or fabricate earlier history. SQLite backups retain policies, run receipts, recipient-specific events and activity.

The process checks at startup and every 300 seconds unless `APPOINTMENT_REMINDERS_AUTO=false`. This environment setting controls the timer, independently of the saved policy; administrator manual checks remain available when the policy is enabled. Shutdown stops the timer. Each check records at most 200 pending notices ordered by appointment start and ID. No-notice checks update bounded worker status without creating empty run history. The page shows automatic/manual operation and last successful/failed check times.

Only currently scheduled appointments whose exact Asia/Kolkata start is still in the future and within the lead window qualify. A later restart can catch a visit while it remains upcoming; it cannot guarantee creation at the exact window-opening time. Visits without an active linked patient account that has completed initial password rotation receive no notice and consume no deduplication key. Multiple processes share transactional deduplication in the same database. Appointment changes, recipient access, policy and current time are rechecked before recording notices.

No provider, external credentials or network delivery is required. Notices are visible in the patient inbox when the app is opened or refreshed. They do not send email, SMS, WhatsApp, push alarms or external calendar updates. Historical notices remain immutable and link to current appointment status. Recording or reading a notice is not evidence of attendance or external delivery.

## Authenticator sign-in and key management

Authenticator MFA is optional. Without `MFA_ENCRYPTION_KEY`, ordinary accounts keep their existing sign-in behavior and new enrollment is unavailable. Configure a unique cryptographically random 32-byte key encoded as 64 hexadecimal characters. Keep it in the application's protected environment or `.env`, never in source control, command history or shared logs. The Compose configuration passes this setting through to the container.

Retain the same key across restarts and protect a separate backup of it. The database contains encrypted authenticator material and hashed active recovery codes; restoring enrolled accounts requires both the database backup and its original key. A missing or incorrect key for existing enrolled credentials causes startup to fail closed. Changing the environment value is not a key-rotation procedure. Do not delete or replace it to work around a startup error. Pending setup material expires and does not activate MFA by itself.

Account holders enroll in **Account & security**. They must keep their authenticator device or a saved recovery code to finish sign-in. The server clock must be accurate: authenticator codes use 30-second time steps with a bounded adjacent-step allowance, and a successfully used step cannot be reused. Authentication attempts are limited per account across server restarts. Password-recovery links retain MFA; administrator web access cannot remove another account's factor.

If all factors are lost, use the local operator reset command described below only after verifying the account holder's identity. Reset records an operator reason and ends existing sessions and pending challenges; it does not issue a session or replace the account password. This operational procedure cannot automatically establish the person's identity.

For a verified lost-factor reset, set the exact existing database and account, and pipe the recorded reason:

```sh
printf '%s\n' 'Identity verified using the clinic recovery procedure; authenticator and recovery codes lost.' | \
  DATABASE_PATH=data/production.sqlite \
  MFA_RESET_EMAIL=account@example.com \
  MFA_RESET_IDENTITY_VERIFIED=true \
  npm run mfa:reset
```

The command also invalidates outstanding password-recovery grants and requires password rotation at the next sign-in. It works without a lost MFA key. If other enrolled accounts remain, their original encryption key is still required to start the application; resetting one account does not make their data decryptable under another key. Operator reasons are retained in the audit log. This command does not prove identity by itself or recover a forgotten password.

## Account access and password recovery

Use **Accounts & access** to suspend a departing staff member, restore access, change a staff role, or set the linked doctor profile. Suspension and role/profile changes immediately end the affected account’s sessions while retaining patient records and past authorship. An administrator cannot suspend their own account or demote the last active administrator. Keep individual administrator accounts rather than sharing one credential.

For a forgotten password:

1. Confirm the person’s identity using your clinic’s process. There is no automatic email/contact verification.
2. As an administrator, open **Accounts & access → Recovery** for the correct active account and confirm the verification.
3. Copy the one-use recovery link and share it privately with that person. The platform does not send it. It expires after 30 minutes; generating another link invalidates the previous link.
4. The account holder opens the link, chooses a new password, and signs in again. Recovery ends every previous session. An expired or already-used link must be replaced by an administrator after verification.

For a suspended account, restore access only if appropriate before issuing recovery. A normal password change invalidates outstanding recovery links and ends other sessions. Users can review and end their own browser sessions in **Account & security**; sessions also expire after twelve hours. The browser-family labels are informational, not device or location verification.

Authentication budgets are stored in the application database and survive restarts; instances sharing that database share the limits. There is no new secret or provider setup. A database-generated HMAC key keeps raw submitted email and network addresses out of limiter rows and failure audit entries; protect it with the database and backups. Login permits twenty network requests and ten failed passwords per normalized email in separate fifteen-minute windows. Other auth operations retain ten or twenty network requests per window. Wait for the time shown by a `429` response; restarting the server does not clear it. Requests from a shared network consume a shared network budget, so configure a trusted proxy correctly when applicable.

Administrators can filter Audit history by record type `auth-security` to inspect bounded failure/throttle evidence. The first and tenth password failures and first throttle per budget window are recorded; this history is not a count of every attempted request. Successful logout records `signed out` in Audit history for the account. Database write failures roll back registration/account and logout/session changes, including cookies, so the user can retry after the database issue is resolved. An already admitted registration or login request still consumes its network allowance even if later writes fail; repeated retries can therefore reach the network limit.

If no administrator can sign in, a trusted deployment operator can run the same administrator-bootstrap command with a **new, unique email** against the existing production database. It creates a separate administrator and refuses to overwrite an existing account. That administrator can then manage access through the audited interface. The operator must already have authorized host/database access; there is no public bootstrap endpoint.

## Public library publication settings

Published articles work locally without any provider or domain configuration. `/library` and `/library/:articleId` include readable initial HTML, search/pagination, recorded author/date and sharing metadata. Changing an article to draft withdraws its document/API response and sitemap entry immediately. A reader or external search engine may retain previously downloaded content; withdrawal cannot erase those copies.

Search indexing is disabled by default. For a deliberately published production installation, the optional settings are:

```dotenv
PUBLIC_SITE_ORIGIN=https://clinic.example.com
PUBLIC_INDEXING_ENABLED=true
```

The canonical origin defaults to `APP_ORIGIN` when `PUBLIC_SITE_ORIGIN` is empty. It must be an HTTPS origin with no credentials, path, query or fragment; HTTP is allowed only for localhost/loopback testing. A root trailing slash is normalized. Invalid explicit origins stop startup. Request Host and forwarded headers never supply public URLs. Without an origin the pages still work, omit absolute metadata and remain noindex; the sitemap is empty.

Indexing additionally requires production mode without demo data. Even with opt-in, only the public library and published article pages are eligible; search results and all other application pages remain noindex. `/sitemap.xml` contains the library index and published article URLs. It supports at most 49,999 published articles and returns a clear error beyond that size rather than a truncated sitemap. The home/discovery page remains client-rendered and is outside this release's indexing scope.

`robots.txt` permits HTML crawling so crawlers can observe noindex and excludes API crawling. These directives do not replace authentication or guarantee indexing/removal. No search-engine account, analytics integration or automatic submission is configured. The existing library authoring review remains the publication gate. Docker Compose forwards both optional settings; no hosting or deployment action is part of local verification.

## TLS and reverse proxy

Terminate HTTPS at your reverse proxy and forward to `127.0.0.1:3001`. Preserve the public `Host` header and forward the original scheme. `APP_ORIGIN` must match the public browser origin; cross-origin writes are rejected.

Set `TRUST_PROXY=true` only when all traffic arrives through your actual, trusted single proxy and the application port is not directly reachable by untrusted clients. This makes login rate limits use the forwarded client address. The proxy must replace client-supplied forwarding headers. Otherwise keep it `false`.

Set a request body allowance of at least 7 MB in the proxy for clinical images; application uploads are limited to 5 MB of decoded image data. Keep `/api` responses private and uncached. The application serves the built frontend and API together, so no separate static hosting or CORS configuration is needed.

## Docker Compose

Docker uses a non-root runtime user and stores the database, private images and audit records in the persistent `clinic-data` volume. The application port is bound only to host loopback; supply your own TLS reverse proxy. Put the public `APP_ORIGIN` and appropriate `TRUST_PROXY` in `.env`.

```sh
docker compose build
```

Create the initial administrator with a fresh volume, using Bash:

```bash
read -r -s -p 'Initial administrator password (12+ characters): ' derma_admin_password
printf '\n'
printf '%s\n' "$derma_admin_password" | docker compose run --rm -T -e ADMIN_EMAIL='admin@example.com' -e ADMIN_NAME='Clinic administrator' app npm run create-admin
unset derma_admin_password
docker compose up -d
docker compose logs --tail=50 app
```

The compose configuration forces production mode and disables demo seeding. Its fixed database path is `/app/data/clinic.sqlite`, independent of a host-local `DATABASE_PATH`. Do not use `docker compose down -v` on an installation whose data you need to retain. For bind mounts, ensure the container’s `node` user (UID 1000) can write the data directory.

The included health check calls `/api/health`. A successful health response confirms the process is responding; it does not verify a reverse proxy, domain or external provider.

## Backup and recovery

Use the online backup command, which includes committed SQLite WAL data and can run while the service is active:

```sh
npm run backup -- /private/clinic-backups/clinic-2026-11-10.sqlite
```

Choose a new filename for each backup. The tool refuses an existing destination, creates a consistent snapshot and publishes it atomically. Failed snapshots are removed. Do not copy only the live `.sqlite` file: recent committed data can still be in its `-wal` sidecar.

For Docker:

```sh
docker compose exec -T app npm run backup -- /app/data/backups/clinic-2026-11-10.sqlite
mkdir -p backups
docker compose cp app:/app/data/backups/clinic-2026-11-10.sqlite ./backups/
```

Move a copy to separately protected storage. A backup includes private patient records, image and PDF bytes, messages, immutable clinical workflow events follow-up reviews and assignments, waitlist requests, invoice/procedure links, expense entries and void history, image annotation/publication records, activity contents and read status, password hashes, account access flags, sessions, hashed recovery grants, encrypted MFA credentials, recovery-code state, MFA evidence/attempts, schedules, and closures. The MFA encryption key must be backed up separately. Limit access and encrypt backup storage. A snapshot kept only in the application volume is not protection against losing that volume.

To restore:

1. Stop the application, including every process using the database (`docker compose stop app` for Docker).
2. Preserve the existing database **and** any `-wal` / `-shm` sidecars together in a recovery directory.
3. Copy the selected completed backup to the configured `DATABASE_PATH`. Do not leave old sidecars next to the restored file. In Docker, perform this inside the mounted `clinic-data` volume while the app is stopped.
4. Before reopening access, remove restored sessions and outstanding recovery grants through trusted database maintenance tooling. For a current-release snapshot, use a transaction containing `DELETE FROM sessions;` and `DELETE FROM recoveryGrants;`. For a snapshot with MFA tables, also delete `mfaChallenges`, `mfaPending` and `mfaRecoveryCodes` in that transaction. This retires restored one-use codes rather than making codes consumed after the backup reusable. Preserve `mfaCredentials` so authenticator verification remains enabled. Omit statements for tables absent from older snapshots.
5. Ensure the runtime user owns the restored file, restrict its access, then start the application. Check `/api/health`, sign in and verify expected records, administrator access, staff suspensions, enrolled MFA state and doctor availability. Enrolled accounts can authenticate with their authenticator and prepare replacement recovery codes; accounts without that factor need the verified local reset procedure.

Restoring also restores account access, passwords, MFA enrollment, scheduling changes, and recovery state to the snapshot time. Reapply factor enrollments/removals that occurred after the snapshot before reopening access. Removing restored sessions and grants prevents old sign-ins or previously consumed links from becoming usable again. Reapply later staff-access changes and rotate credentials if a snapshot may have been exposed. Regularly rehearse restoration into a separate isolated database.

## Integration boundaries

Booking, clinical documentation, images and PDFs, clinician-authored image annotations and patient-facing summary exports, investigations, procedure records, care plans, check-ins, clinician follow-up reviews, private messaging, confirmed waitlist booking, clinical handovers, activity inboxes, procedure-linked invoice creation, manual payment records, calendar export and approved clinic articles work within the application. Billing records payments already received; it does not charge a card or initiate a UPI payment. Tax calculation, refunds and payment-provider reconciliation are not automated. Administrators can record expenses, void mistaken entries with a reason, review clinic aggregates and export aggregate CSV reports. This does not initiate a payment or provide accounting reconciliation.

Activity updates are visible when the app opens or the inbox refreshes. Enabled follow-up escalation policies create staff notices at startup and every 15 minutes while the server runs. There is no external delivery service, email/SMS/WhatsApp dispatch or push subscription. Staff should continue their clinic’s existing process for time-sensitive outreach. A clinician’s request for a visit offers the patient a booking link; it does not reserve an appointment.

Email, SMS, WhatsApp, video meetings, native mobile packaging, AI diagnosis and voice transcription require separate implementation and provider configuration. Online appointments do not create video rooms. No external delivery is represented as successful when a provider is absent. Clinician-entered instructions and warnings are not validated against a drug-interaction database.

Booking uses the configured doctor sessions and closures in Asia/Kolkata, up to 180 days ahead. New bookings use the doctor’s current appointment length; saved appointments retain their recorded duration. Appointment changes create in-app activity updates. Waitlist requests capture preferred dates and require explicit confirmation of an available slot before booking. Overnight sessions, external calendar synchronization and external reschedule notifications are not implemented. Clinic opening-hours text is display content; change **Availability & time off** to alter bookable hours.

## Reproducible runtime verification

After `npm run build`, run `npm run test:production`. This boots a new temporary database with a generated administrator password passed through stdin, verifies production identity and security headers, serves a built SPA route, and removes its temporary data. It does not use your clinic database.

To check the container locally:

```sh
docker build -t derma-platform:verify .
npm run test:production -- --image derma-platform:verify
```

The container check publishes only to a random loopback port and removes its disposable container and anonymous data volume after verification. The production image build and startup were verified locally on 10 November 2026. These checks do not provision public hosting, HTTPS certificates, or external providers.

Care-summary JSON exports and printed pages contain private patient-facing care information. They omit internal notes and original file bytes; they are not a full database or internal-record export. Download permission is checked for every request. Live downloads and new saves require a current reviewed revision. Saved-copy downloads return the original bytes even after the live record changes; these historical copies may be outdated, and their image/PDF references still require current authorization.

PDFs have format/size checks and download as authenticated attachments; a malware-scanning or document-sanitization service is not connected.

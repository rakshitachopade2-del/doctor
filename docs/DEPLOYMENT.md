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

## Upgrade an existing installation

Create and verify a backup before replacing the running application. Stop the service, install the new dependencies, build, and restart against the same production database. Startup creates the scheduling and recovery tables and adds session metadata where needed. Existing users retain their current access; the new mandatory-password rule applies to newly provisioned accounts. Existing doctor profiles retain the original default hours until an authorized user saves another schedule. Previously booked appointments without a stored duration continue to count as 30 minutes.

After restart, confirm account access and review each doctor’s actual hours and planned closures. An upgrade does not automatically reschedule, cancel, or notify patients. Keep the pre-upgrade backup so application code and database state can be restored together if rollback is required.

## Account access and password recovery

Use **Accounts & access** to suspend a departing staff member, restore access, change a staff role, or set the linked doctor profile. Suspension and role/profile changes immediately end the affected account’s sessions while retaining patient records and past authorship. An administrator cannot suspend their own account or demote the last active administrator. Keep individual administrator accounts rather than sharing one credential.

For a forgotten password:

1. Confirm the person’s identity using your clinic’s process. There is no automatic email/contact verification.
2. As an administrator, open **Accounts & access → Recovery** for the correct active account and confirm the verification.
3. Copy the one-use recovery link and share it privately with that person. The platform does not send it. It expires after 30 minutes; generating another link invalidates the previous link.
4. The account holder opens the link, chooses a new password, and signs in again. Recovery ends every previous session. An expired or already-used link must be replaced by an administrator after verification.

For a suspended account, restore access only if appropriate before issuing recovery. A normal password change invalidates outstanding recovery links and ends other sessions. Users can review and end their own browser sessions in **Account & security**; sessions also expire after twelve hours. The browser-family labels are informational, not device or location verification.

If no administrator can sign in, a trusted deployment operator can run the same administrator-bootstrap command with a **new, unique email** against the existing production database. It creates a separate administrator and refuses to overwrite an existing account. That administrator can then manage access through the audited interface. The operator must already have authorized host/database access; there is no public bootstrap endpoint.

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

Move a copy to separately protected storage. A backup includes private patient records, image bytes, messages, password hashes, account access flags, sessions, hashed recovery grants, schedules, and closures. Limit access and encrypt backup storage. A snapshot kept only in the application volume is not protection against losing that volume.

To restore:

1. Stop the application, including every process using the database (`docker compose stop app` for Docker).
2. Preserve the existing database **and** any `-wal` / `-shm` sidecars together in a recovery directory.
3. Copy the selected completed backup to the configured `DATABASE_PATH`. Do not leave old sidecars next to the restored file. In Docker, perform this inside the mounted `clinic-data` volume while the app is stopped.
4. Before reopening access, remove restored sessions and outstanding recovery grants through trusted database maintenance tooling. For a current-release snapshot, use a transaction containing `DELETE FROM sessions;` and `DELETE FROM recoveryGrants;`. A snapshot from before recovery support has no `recoveryGrants` table; omit that statement for such a snapshot.
5. Ensure the runtime user owns the restored file, restrict its access, then start the application. Check `/api/health`, sign in and verify expected records, administrator access, staff suspensions, and doctor availability.

Restoring also restores account access, passwords, scheduling changes, and recovery state to the snapshot time. Removing restored sessions and grants prevents old sign-ins or previously consumed links from becoming usable again. Reapply later staff-access changes and rotate credentials if a snapshot may have been exposed. Regularly rehearse restoration into a separate isolated database.

## Integration boundaries

Booking, clinical documentation, images, care plans, check-ins, private messaging, invoice creation, manual payment records, calendar export and approved clinic articles work within the application. Billing records payments already received; it does not charge a card or initiate a UPI payment. Tax calculation, refunds and payment-provider reconciliation are not automated.

Email, SMS, WhatsApp, video meetings, native mobile packaging, AI diagnosis and voice transcription require separate implementation and provider configuration. Online appointments do not create video rooms. No external delivery is represented as successful when a provider is absent. Clinician-entered instructions and warnings are not validated against a drug-interaction database.

Booking uses the configured doctor sessions and closures in Asia/Kolkata, up to 180 days ahead. New bookings use the doctor’s current appointment length; saved appointments retain their recorded duration. Overnight sessions, waitlists, external calendar synchronization, and automatic reschedule notifications are not implemented. Clinic opening-hours text is display content; change **Availability & time off** to alter bookable hours.

## Reproducible runtime verification

After `npm run build`, run `npm run test:production`. This boots a new temporary database with a generated administrator password passed through stdin, verifies production identity and security headers, serves a built SPA route, and removes its temporary data. It does not use your clinic database.

To check the container locally:

```sh
docker build -t derma-platform:verify .
npm run test:production -- --image derma-platform:verify
```

The container check publishes only to a random loopback port and removes its disposable container and anonymous data volume after verification. The production image build and startup were verified locally on 10 November 2026. These checks do not provision public hosting, HTTPS certificates, or external providers.

Clinical workflow and private PDF tables are added automatically on startup. Existing notes, plans, appointments, and images remain intact. Include the SQLite database in backups: it now contains original report bytes and immutable investigation/procedure/amendment events. PDFs have format/size checks and download as authenticated attachments; a malware-scanning or document-sanitization service is not connected.

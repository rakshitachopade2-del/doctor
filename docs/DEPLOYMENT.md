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

Sign in over HTTPS. Configure clinic details, create doctor profiles, and add individual staff accounts in **Clinic settings → Your team**. Clinical notes and care plans must be authored from an account linked to a doctor profile. The bootstrap administrator has no doctor identity; create a doctor profile and a separate linked doctor account before documenting care. Existing walk-in records can receive portal accounts only after an administrator confirms the patient’s identity and email. Accounts are never automatically linked by matching email. Users can change their initial passwords in **Account & security**.

A database seeded in demo mode is deliberately rejected by production. Keep demo and production databases separate; importing fictional records is not a production migration.

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

Move a copy to separately protected storage. A backup includes private patient records, image bytes, messages, password hashes and session data. Limit access and encrypt backup storage. A snapshot kept only in the application volume is not protection against losing that volume.

To restore:

1. Stop the application, including every process using the database (`docker compose stop app` for Docker).
2. Preserve the existing database **and** any `-wal` / `-shm` sidecars together in a recovery directory.
3. Copy the selected completed backup to the configured `DATABASE_PATH`. Do not leave old sidecars next to the restored file. In Docker, perform this inside the mounted `clinic-data` volume while the app is stopped.
4. Ensure the runtime user owns the restored file, restrict its access, then start the application. Check `/api/health`, sign in and verify expected records.

Restoring also restores session state at the snapshot time. Expired sessions are still rejected; if a snapshot may have been exposed, rotate credentials and invalidate existing sessions before reopening access. Regularly rehearse restoration into a separate isolated database.

## Integration boundaries

Booking, clinical documentation, images, care plans, check-ins, private messaging, invoice creation, manual payment records, calendar export and approved clinic articles work within the application. Billing records payments already received; it does not charge a card or initiate a UPI payment. Tax calculation, refunds and payment-provider reconciliation are not automated.

Email, SMS, WhatsApp, video meetings, native mobile packaging, AI diagnosis and voice transcription require separate implementation and provider configuration. Online appointments do not create video rooms. No external delivery is represented as successful when a provider is absent. Clinician-entered instructions and warnings are not validated against a drug-interaction database.

Booking uses 30-minute slots Monday–Saturday, 09:00–17:30 in Asia/Kolkata, up to 180 days ahead. Clinic opening-hours text is display content; changing it does not alter the scheduling engine.

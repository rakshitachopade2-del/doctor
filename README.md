# Derma — care, connected

A working dermatology clinic and patient-care platform, built from the supplied **Dermatology Clinic Platform Concept Document**. It connects public discovery, booking, clinic operations, longitudinal records, treatment communication, and follow-up in one responsive application.

![Derma clinic overview with synthetic demonstration records](docs/screenshots/clinic-dashboard.png)

This is a **single-clinic release** with a real API, database, authentication, role permissions, and synthetic demonstration accounts. It does not need paid services to run locally.

## Start the demo

Requires **Node.js 24** and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Choose **Sign in**, then a demo role. Data is persisted in `data/clinic.sqlite`; restarting the app does not reset changes.

| Role          | Email                  | Password          |
| ------------- | ---------------------- | ----------------- |
| Doctor        | `doctor@derma.demo`    | `DemoClinic2026!` |
| Reception     | `reception@derma.demo` | `DemoClinic2026!` |
| Patient       | `patient@derma.demo`   | `DemoClinic2026!` |
| Administrator | `admin@derma.demo`     | `DemoClinic2026!` |

These are intentionally public **development-only credentials**. Production startup rejects demo mode and demo databases. All demo people, qualifications, clinical notes, and treatment examples are fictional.

## What works

- **Discovery:** doctor profiles, focus areas, qualifications, languages, consultation fees, and clinic contact information.
- **Booking:** in-person or online appointment requests, live availability, duplicate-slot protection, rescheduling, cancellation, check-in, consultation progression, no-shows, and `.ics` calendar export.
- **Clinic workspace:** daily dashboard, seven-day appointment activity, searchable patients, registration, and follow-up worklists.
- **Patient preparation:** a structured four-step history intake, reviewable summary, explicit sharing agreement, and clinician access to submitted history.
- **Longitudinal records:** append-only consultation notes, history, investigations documented as text/image reports, dated private images, treatment plans, and side-by-side image comparison.
- **Treatment communication:** clinician-entered medication instructions, schedules, duration, expectations, costs, precautions, and follow-up dates. Patients can review both active and completed plans.
- **Follow-up:** daily patient-reported adherence and wellbeing check-ins, in-app clinician/patient messages, and overdue-review lists.
- **Billing:** itemized invoices, exact integer-paise arithmetic, recorded cash/card/UPI/bank payments, partial balances, printable invoices, and private patient invoice access. Invoice and payment retries are idempotent.
- **Knowledge library:** clinician-authored drafts, explicit review before public publication, search, and retained article revisions. No AI-generated clinical claims are presented as approved information.
- **Administration:** clinic details, doctor profiles, staff accounts, optional module switches, activity logs, and verified portal access for an existing clinic patient.
- **Access:** password hashing, HTTP-only sessions, CSRF protection, role checks, patient ownership checks, login throttling, password changes, and revocation of other sessions after password changes.
- **Mobile:** responsive layouts, mobile navigation, keyboard-accessible dialogs, printable records, and a standalone web-app manifest. Private medical records are not cached for offline use.

## Try an end-to-end journey

1. Open the public clinic and explore the doctor profiles.
2. Create a patient account, prepare a history, and book an available future slot.
3. Sign in as Doctor, find the patient, and add a consultation note and care plan.
4. Return to the patient account to view the plan, report a daily check-in, and send a message.
5. Use the clinic follow-up list to review the record and reply.
6. Create an invoice in Billing, record a payment already received, and view the balance in the patient portal.

Reception can manage appointments, demographics, and billing. Clinicians can access clinic-wide clinical records. Administrators additionally manage accounts, configuration, and the audit log. Patients can access only their own protected records. Internal consultation notes remain clinician-only; structured care plans carry the patient-facing instructions.

If reception registers a patient first, an administrator can use **Clinic settings → Your team → Patient portal access** after verifying identity. This links an account to the existing record; the system never links records just because an unverified email matches.

## Verify

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

API tests use isolated databases. Browser tests start separate servers on ports **5183 / 3011**, create a temporary synthetic database, and clean it up on exit. The local browser suite uses installed Google Chrome. To use Playwright Chromium instead, run with `CI=true` after `npx playwright install chromium`. CI installs its own Chromium.

The test suite covers role and ownership isolation, CSRF/origin checks, simultaneous booking conflicts, invalid appointment transitions, record privacy, care plans/check-ins, image validation, module switches, persistence, invoice/payment retries and concurrent payments, knowledge publication, existing-record account provisioning, and complete browser workflows.

```sh
npm run format        # format source with Prettier
npm run format:check  # check formatting
npm audit            # inspect dependency advisories
```

## Run without demo data

`npm start` is **production-only**. Build first, use a fresh database, and bootstrap an administrator before signing in. HTTPS is required for production session cookies.

Follow [deployment and backups](docs/DEPLOYMENT.md) for the exact setup, Docker deployment, reverse proxy, administrator bootstrap, online backups, and restoration procedure. Copy `.env.example` to `.env` and configure it for your host. Never commit `.env`, the SQLite database, backups, or real patient files.

## Deliberate boundaries

| Area                      | Current behavior                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI, voice, diagnosis      | Structured text intake is implemented. LLMs, voice recognition, automated diagnosis, image diagnosis, and automatic drug warnings are not connected. Medical decisions remain clinician-entered.                                                               |
| Messages and reminders    | In-app messages and follow-up worklists work. Email, SMS, WhatsApp, push alarms, and background reminder delivery need provider integrations. Nothing is silently marked as externally delivered.                                                              |
| Payments                  | Records payments received elsewhere. No gateway, card collection, automated tax calculation, refunds, or subscription charging.                                                                                                                                |
| Online visits             | Booking works; the clinic coordinates connection details. No hosted video calls.                                                                                                                                                                               |
| Scheduling                | Asia/Kolkata, Monday–Saturday, 30-minute slots from 09:00 through 17:30, up to 180 days ahead. Clinic-hours text is display-only. No per-doctor working-hour editor or holiday calendar yet.                                                                   |
| Accounts                  | Local password accounts. No email verification, self-service password recovery, MFA, or external SSO. Administrator-assisted existing-patient access is available.                                                                                             |
| Files and consent         | Private JPEG/PNG/WebP images and photographed reports; text investigation records. Treatment-use agreement is recorded. No PDF/video uploads, legal e-signatures, public image reuse, research permissions, or model training.                                 |
| Organization              | One clinic per deployment. Clinicians share clinic records; there is no multi-tenant isolation or assigned-doctor restriction.                                                                                                                                 |
| Native apps and workbench | Responsive web app; no separate native iOS/Android app. IPD, inventory, hospital navigation, research assistants, education simulations, clinical calculators, and outcome/reputation scoring remain future modules.                                           |
| Operational assurance     | SQLite persistence, access checks, and audit records are implemented. Hosting, disk encryption, recovery policy, monitoring, and clinical/privacy review belong to the real deployment. This repository makes no certification or regulatory-compliance claim. |

See [concept-to-release mapping](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md), and [API contract](docs/API.md) for implementation details and remaining product scope.

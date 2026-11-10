# Release verification

Release **1.2.0**, verified locally on **10 November 2026** using Node.js **24.13.0** and Google Chrome through Playwright.

| Check                           | Result                                                  |
| ------------------------------- | ------------------------------------------------------- |
| TypeScript                      | Passed                                                  |
| API and online-backup tests     | 65 passed                                               |
| Browser and accessibility tests | 18 passed                                               |
| Production frontend build       | Passed                                                  |
| Fresh production startup        | Passed                                                  |
| Production dependency audit     | 0 vulnerabilities reported                              |
| Prettier and whitespace checks  | Passed                                                  |
| Docker Compose configuration    | Valid                                                   |
| Docker image build/runtime      | Passed: image build and disposable production container |

The production smoke check used a new temporary database and a randomly generated administrator password. It verified administrator bootstrap, disabled demo mode, absence of fictional doctor profiles, a Secure session cookie, built SPA route serving, and security headers. The same reusable check also passed against the production Docker image. Temporary databases, the container, and its anonymous volume were removed afterward. Run `npm run test:production` after building; use `npm run test:production -- --image derma-platform:verify` to check a built container image.

API tests exercise authentication, session expiry, CSRF/origin rejection, role/ownership isolation, simultaneous booking conflicts, invalid dates/states, private records/images, care plans, check-ins, module switches, persistence, clinical authorship, invoices, exact paise arithmetic, retries, concurrent payments, article publication/revisions, verified patient access, consistent backups of committed WAL data, configurable schedules and closures, duration overlap checks, forced password rotation, recovery expiry/replay/supersession, account suspension, session revocation, last-administrator protection, migration compatibility, private PDF bytes/provenance/format limits, immutable clinical amendments, investigation result review/publication, procedure decision history, and completion timing/concurrency.

Browser tests exercise complete patient and clinic workflows, portal provisioning, decimal invoice balances, published/private article separation, calendar downloads, file upload/comparison, optional-module continuity, mobile layouts, keyboard dialog behavior, doctor-specific hours and modes, conflict-safe time off, staff account recovery, initial password changes, suspension/restoration, ending individual sessions, report upload/download, clinician review sharing, patient procedure decisions, and preserved clinical corrections.

Axe checks in the browser suite report no detectable WCAG 2 A/AA and 2.1 AA violations on public discovery/sign-in, the clinic dashboard/booking dialog, mobile patient care/records, account security, and desktop/mobile scheduling, clinical workup and amendments, and mobile patient investigations/procedures/PDF reports. Additional development checks covered clinic records, follow-ups, billing, knowledge, settings, and invoice/article/check-in dialogs. Automated checks are bounded to those rendered states; they do not establish comprehensive accessibility certification.

Screenshots use only synthetic demonstration records:

- [Clinic dashboard](screenshots/clinic-dashboard.png)
- [Public discovery](screenshots/public-discovery.png)
- [Patient care on mobile](screenshots/patient-mobile.png)
- [Clinical investigations and procedures](screenshots/clinical-workup.png)
- [Private PDF reports on mobile](screenshots/patient-reports-mobile.png)

CI repeats type checks, API tests, build, the local production smoke check, and Chromium browser checks after pushes. Browser tests use independent temporary databases for care and operations workflows; authentication rate limits remain enabled. Its remote result is separate from the local results above.

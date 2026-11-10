# Release verification

Release **1.1.0**, verified locally on **10 November 2026** using Node.js **24.13.0** and Google Chrome through Playwright.

| Check                           | Result                                               |
| ------------------------------- | ---------------------------------------------------- |
| TypeScript                      | Passed                                               |
| API and online-backup tests     | 50 passed                                            |
| Browser and accessibility tests | 16 passed                                            |
| Production frontend build       | Passed                                               |
| Fresh production startup        | Passed                                               |
| Production dependency audit     | 0 vulnerabilities reported                           |
| Prettier and whitespace checks  | Passed                                               |
| Docker Compose configuration    | Valid                                                |
| Docker image build/runtime      | Not verified: Docker daemon unavailable on this host |

The production smoke check used a new temporary database and a randomly generated administrator password. It verified administrator bootstrap, disabled demo mode, absence of fictional doctor profiles, a Secure session cookie, built SPA route serving, and security headers. Temporary data was removed afterward.

API tests exercise authentication, session expiry, CSRF/origin rejection, role/ownership isolation, simultaneous booking conflicts, invalid dates/states, private records/images, care plans, check-ins, module switches, persistence, clinical authorship, invoices, exact paise arithmetic, retries, concurrent payments, article publication/revisions, verified patient access, consistent backups of committed WAL data, configurable schedules and closures, duration overlap checks, forced password rotation, recovery expiry/replay/supersession, account suspension, session revocation, last-administrator protection, and migration compatibility.

Browser tests exercise complete patient and clinic workflows, portal provisioning, decimal invoice balances, published/private article separation, calendar downloads, file upload/comparison, optional-module continuity, mobile layouts, keyboard dialog behavior, doctor-specific hours and modes, conflict-safe time off, staff account recovery, initial password changes, suspension/restoration, and ending individual sessions.

Axe checks in the browser suite report no detectable WCAG 2 A/AA and 2.1 AA violations on public discovery/sign-in, the clinic dashboard/booking dialog, mobile patient care/records, account security, and desktop/mobile scheduling. Additional development checks covered clinic records, follow-ups, billing, knowledge, settings, and invoice/article/check-in dialogs. Automated checks are bounded to those rendered states; they do not establish comprehensive accessibility certification.

Screenshots use only synthetic demonstration records:

- [Clinic dashboard](screenshots/clinic-dashboard.png)
- [Public discovery](screenshots/public-discovery.png)
- [Patient care on mobile](screenshots/patient-mobile.png)

CI is configured to repeat type checks, tests, build, and Chromium browser checks after pushes. Its remote result is separate from the local results above.

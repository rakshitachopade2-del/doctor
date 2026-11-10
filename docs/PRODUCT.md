# Product decisions and concept coverage

The supplied concept is source material, not an instruction to make unsupported medical or commercial claims. Its unresolved items remain unresolved unless this implementation establishes a concrete operational behavior.

## Release scope

| Concept                             | Implemented behavior                                                                                                        | Remaining extension                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Dermatology-first, optional modules | Dermatology public discovery; intake, images, and follow-up can be switched off by administrators                           | Add-on subscription billing, other specialties                                 |
| Doctor professional identity        | Editable qualifications, focus areas, languages, experience, fee, biography                                                 | Credential verification, research/reviews, outcome-based reputation            |
| Online and offline care             | Shared booking/queue/calendar workflow; online mode labeled accurately                                                      | Video-call integration                                                         |
| Personalized intake                 | Structured concern, location, duration, symptoms, triggers, prior care, medications, allergies, goals, review and agreement | Validated AI differential support, multilingual voice                          |
| One record across time              | History, images, investigations as text or photographed reports, immutable clinician notes, care plans                      | Typed investigation objects, PDFs/videos, formal amendments/signatures         |
| Understandable treatment            | Clinician-entered schedules, instructions, expectations, precautions, duration, costs, follow-up                            | Verified medication knowledge and drug interaction rules                       |
| Follow-up and adherence             | Daily patient reports, chronological history, due-review worklist, messages                                                 | Scheduled external reminders, WhatsApp fallback, validated clinical scores     |
| Clinical image comparison           | Private dated images, two-image comparison, treatment-use permission                                                        | Annotation/measurement, independent consent categories, diagnostic models      |
| Clinic operations                   | Dashboard, patient registration, bookings, staff roles, itemized service/procedure invoices                                 | Dedicated procedure scheduling, IPD, pharmacy/inventory, expenses              |
| Reliable evidence                   | Append-only clinical notes, audit events, immutable payment records, published-article revisions                            | Tamper-evident external logging, retention and jurisdiction-specific processes |
| Clinic workbench                    | Searchable clinician-reviewed information library and draft/public separation                                               | Source-grounded AI, research/content studio, simulation and calculators        |
| Doctor-managed public website       | Clinic contact/profile edits, doctor editing, article publishing                                                            | Visual page builder, custom branding editor, hosted domains                    |

## Decisions made for this release

- One deployed clinic with four explicit roles. Doctor accounts are tied to professional profiles. Administrator access includes clinical operations.
- Local accounts avoid dependency on an external identity provider. Production never accepts a demo-seeded database.
- Time slots are authoritative on the server. Doctor and patient conflicts are guarded by database unique indexes, including simultaneous requests.
- Appointment states follow a defined transition graph. Patients may cancel or reschedule their own scheduled appointments; they cannot progress clinic states.
- Internal visit notes are clinician-only. Patients receive the structured care plan and their shared history, images, messages, appointments, and invoices.
- Clinical instructions are entered by a clinician. No medication recommendation, clinical probability, image-based score, or future-outcome image is generated.
- Check-ins are explicitly patient-reported. One per care plan/day can be corrected; changes are audited. They are not presented as observed adherence or clinical efficacy.
- Image agreement covers private treatment use only. There is no automatic publishing path from a clinical image to the public website.
- Draft knowledge is private. Publication requires an explicit clinician review action. Editing published material returns it to draft unless it is explicitly approved again.
- Payments use integer paise, reject overpayment, and support safe retries. Recorded payment methods describe receipt elsewhere and do not initiate a charge.
- Existing patient records are linked to portal accounts only by an administrator after an explicit identity-verification confirmation. Email matching alone never grants record access.
- The product remains useful without external integrations. Unconfigured providers are displayed as unavailable, without fake success states.

## Next substantial releases

1. Configurable clinician schedules, closures, reschedule notifications, and externally delivered reminders with delivery logs.
2. Production identity improvements: verified contact methods, password recovery, MFA, staff deactivation, and clinic onboarding.
3. Structured investigations and procedure records, document uploads, amendment workflows, and granular consent categories.
4. Validated clinician workbench modules with approved sources, version history, and clinical review.
5. Multi-clinic isolation and scalable storage/operations once deployment requirements are known.

These are feature groups suitable for meaningful commits. They are not represented as complete in the current release.

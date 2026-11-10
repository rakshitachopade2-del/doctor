# Application contract

All JSON API paths start `/api`. Errors: `{error: string}` with proper status. Successful list endpoints return arrays. Dates are YYYY-MM-DD in Asia/Kolkata; times HH:mm (24 hour). Types are in shared/types.ts. All writes except login/register require session `X-CSRF-Token` header. Session cookie is HTTP-only. Role and ownership are enforced on server. Demo accounts all use password `DemoClinic2026!` and emails doctor@derma.demo, reception@derma.demo, patient@derma.demo, admin@derma.demo. Synthetic data only.

- GET /session => Session
- POST /auth/login {email,password} => Session
- POST /auth/register {name,email,password,phone,dob,gender} => Session (patient only)
- POST /auth/logout => {ok:true}
- GET /doctors => Doctor[] (public)
- GET /settings => ClinicSettings (public safe fields)
- PATCH /settings => ClinicSettings (admin; editable fields matching type)
- GET /slots?doctorId=&date= => string[] available start times (public)
- GET /dashboard => Dashboard (staff)
- GET /patients?search= => Patient[] (staff; reception demographics only)
- POST /patients {name,email,phone,dob,gender,allergies} => Patient (staff)
- GET /patients/:id => PatientRecord (doctor/admin or own patient; reception denied)
- GET /appointments?date=&doctorId= => Appointment[] (staff or own patient)
- POST /appointments {patientId?,doctorId,date,time,mode,reason} => Appointment (own patient or staff)
- PATCH /appointments/:id {status?,date?,time?,doctorId?} => Appointment (staff valid transitions; patient cancel/reschedule own)
- GET /appointments/:id/calendar => text/calendar (authorized)
- POST /intakes {patientId?, concern,location,duration,symptoms,triggers,previousTreatment,medications,allergies,goals,consent:true} => Intake (patient own or clinician)
- POST /encounters {patientId,appointmentId?,history,examination,assessment,investigations,plan} => Encounter (doctor/admin)
- GET /care-plans => CarePlan[] (doctor/admin or own patient)
- POST /care-plans {patientId,title,instructions,expectations,warnings,cost,startDate,endDate,followUpDate,medications} => CarePlan (doctor/admin)
- PATCH /care-plans/:id {status} => CarePlan (doctor/admin)
- POST /check-ins {carePlanId,date,adherence,feeling,note} => CheckIn (own patient; one per plan/day upsert)
- POST /images {patientId?,caption,category,consent:true,dataUrl} => ClinicalImage (own patient or clinician; bounded real JPEG/PNG/WebP)
- GET /images/:id/file => private file with ownership checks
- GET /messages?patientId= => Message[] (clinician or own patient)
- POST /messages {patientId?,body} => Message (clinician or own patient)
- GET /audit => AuditEntry[] (admin)
- GET /health => {status:'ok'}

Frontend shared tools in src/lib.tsx: `api<T>(path, {method?,body?})`, `useSession()` => `{session,refresh}`, `useResource<T>(path)` => `{data,loading,error,reload}`, `useToast()` => `(message, type?:'success'|'error')=>void`, `today()`, `formatDate(date)`, `money(number)`. api path includes `/api`. Components src/components/ui.tsx: `PageHeader({eyebrow?,title,description?,actions?})`, `Card({children,className?})`, `Badge({children,tone?})`, `Avatar({name,color?,size?})`, `EmptyState({title,description?,action?})`, `Modal({title,onClose,children})`, `Field({label,children,hint?})`, `Loading`, `ErrorState({message,retry?})`. Use native HTML forms/buttons + global classes button, button-primary, button-secondary, button-ghost, button-small, input, select, textarea, form-grid, stack, grid-2, grid-3, card, muted, row, between, section-title, table-wrap, data-table, notice, metric-grid, metric-card, pill, segmented, tabs. Shared styling lives in `src/styles.css`; each page family has its own stylesheet.

Frontend routes: `/` public discovery; `/login`; `/register`; `/book` booking; `/intake` structured intake; `/my-care` patient home; `/my-care/record` patient record; `/my-care/messages` messages; `/clinic` staff dashboard; `/clinic/appointments`; `/clinic/patients`; `/clinic/patients/:id`; `/clinic/follow-ups`; `/clinic/settings`; `/clinic/audit`. The frontend is divided into shell, authentication, clinic operations, patient care, and administration pages.

## Administration and operations

Password creation/change requires 12–128 characters. Staff-created patient records may omit email and date of birth; patient registration requires both. Appointment slots run Monday–Saturday, 09:00–17:30 IST, for the next 180 days. Internal encounters are omitted from patient-facing record responses.

- GET /users => User[] (admin)
- POST /users {name,email,password,role,doctorId?} => User (admin; doctor role requires a profile)
- POST /doctors, PATCH /doctors/:id => Doctor (admin; full profile)
- POST /auth/password {currentPassword,newPassword} => {ok:true}; invalidates other sessions
- POST /patients/:id/portal-account {email,password,identityVerified:true} => User (admin; requires unlinked record and unused email)
- GET /invoices => Invoice[] (staff or own patient)
- POST /invoices {patientId,items:[{description,quantity,unitAmountPaise}],requestId?} => Invoice (staff). Integer money; optional UUID requestId supports safe replay.
- GET /invoices/:id => {invoice,payments} (staff or owning patient)
- POST /invoices/:id/payments {amountPaise,method,reference?,requestId} => {invoice,payments} (staff). UUID requestId required. Methods: cash/card/upi/bank. Identical retries return the original payment state; changed request content is rejected.
- GET /knowledge => published KnowledgeArticle[] (public)
- GET /knowledge/manage => KnowledgeArticle[] (clinician)
- POST /knowledge {title,category,body} => draft KnowledgeArticle (clinician)
- PATCH /knowledge/:id {title?,category?,body?,status?} => KnowledgeArticle (clinician). Edited content becomes draft unless explicitly reapproved with status:published.

Operation models are in `shared/operations.ts`. Additional frontend routes: `/clinic/billing`, `/my-care/invoices`, `/clinic/knowledge`, `/library`, `/my-care/library`, `/account`.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft, History, Pencil, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import type {
  AllergyStatus,
  PatientAllergies,
  PatientAllergyHistory,
  PatientDemographics,
  PatientProfile,
} from '../../shared/patient-profile';
import { api, ApiError, formatDate, today, useResource, useSession, useToast } from '../lib';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './patient-profile.css';

const demographicFields: [keyof PatientDemographics, string][] = [
  ['name', 'Full name'],
  ['email', 'Contact email'],
  ['phone', 'Phone number'],
  ['dob', 'Date of birth'],
  ['gender', 'Gender'],
];
const allergyLabels: Record<AllergyStatus, string> = {
  'not-recorded': 'Not recorded',
  'none-known': 'No known allergies recorded',
  recorded: 'Allergies recorded',
};
const timestamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const errorText = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'The update could not be confirmed. Please try again.';
const displayValue = (key: keyof PatientDemographics, value: string) =>
  value ? (key === 'dob' ? formatDate(value) : value) : 'Not recorded';
const validRevision = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function checkedProfile(
  value: unknown,
  patientId: string,
  requireRevision = false,
): PatientProfile {
  const profile = value as PatientProfile | null;
  if (
    !profile ||
    profile.patientId !== patientId ||
    !profile.demographics ||
    !demographicFields.every(([key]) => typeof profile.demographics[key] === 'string') ||
    !Array.isArray(profile.changes) ||
    (requireRevision && !validRevision(profile.revision))
  )
    throw new Error(
      'The response did not confirm the matching patient details. Refresh the record or retry the same submitted update.',
    );
  return profile;
}
function checkedAllergies(
  value: unknown,
  patientId: string,
  requireRevision = false,
): PatientAllergyHistory {
  const record = value as PatientAllergyHistory | null;
  if (
    !record ||
    record.patientId !== patientId ||
    !record.current ||
    !Object.hasOwn(allergyLabels, record.current.status) ||
    typeof record.current.text !== 'string' ||
    (record.current.status === 'recorded'
      ? !record.current.text.trim()
      : record.current.text !== '') ||
    !Array.isArray(record.changes) ||
    (requireRevision && !validRevision(record.revision))
  )
    throw new Error(
      'The response did not confirm the matching allergy record. Refresh the record or retry the same submitted update.',
    );
  return record;
}
function normalizeDemographics(values: PatientDemographics): PatientDemographics {
  return {
    name: values.name.trim(),
    email: values.email.trim().toLowerCase(),
    phone: values.phone.trim(),
    dob: values.dob,
    gender: values.gender.trim(),
  };
}
function normalizeAllergies(values: PatientAllergies): PatientAllergies {
  return { status: values.status, text: values.status === 'recorded' ? values.text.trim() : '' };
}

type Attempt = { path: string; method: 'PATCH' | 'POST'; body: Record<string, unknown> };
type DraftCommon = {
  patientId: string;
  requestId: string;
  reason: string;
  phase: 'editing' | 'uncertain' | 'conflict';
  attempt: Attempt | null;
  error: string;
};
type DemographicDraft = DraftCommon & {
  kind: 'demographics';
  source: PatientProfile;
  values: PatientDemographics;
  reviewed: PatientProfile | null;
};
type AllergyDraft = DraftCommon & {
  kind: 'allergies';
  source: PatientAllergyHistory;
  values: PatientAllergies;
  reviewed: PatientAllergyHistory | null;
};
type CorrectionDraft = DemographicDraft | AllergyDraft;

export function PatientProfilePage() {
  const { id } = useParams();
  const { session } = useSession();
  if (!session.user) return <Navigate to="/login" replace />;
  const patientView = session.user.role === 'patient';
  const patientId = patientView ? session.user.patientId : id;
  if (!patientId)
    return (
      <EmptyState
        title="Choose a patient to view their details"
        action={
          <Link
            className="button button-secondary"
            to={patientView ? '/my-care' : '/clinic/patients'}
          >
            Return to patients
          </Link>
        }
      />
    );
  return (
    <ProfileWorkspace
      key={`${patientId}:${session.user.role}`}
      patientId={patientId}
      patientView={patientView}
      reception={session.user.role === 'receptionist'}
      canWriteAllergies={!!session.user.doctorId && ['doctor', 'admin'].includes(session.user.role)}
    />
  );
}

function ProfileWorkspace({
  patientId,
  patientView,
  reception,
  canWriteAllergies,
}: {
  patientId: string;
  patientView: boolean;
  reception: boolean;
  canWriteAllergies: boolean;
}) {
  const profile = useResource<PatientProfile>(
    `/api/patients/${encodeURIComponent(patientId)}/profile`,
  );
  const allergies = useResource<PatientAllergyHistory>(
    reception ? null : `/api/patients/${encodeURIComponent(patientId)}/allergies`,
  );
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  let profileData: PatientProfile | null = null,
    allergyData: PatientAllergyHistory | null = null;
  let profileError = profile.error,
    allergyError = allergies.error;
  if (profile.data && !profile.loading && !profileError) {
    try {
      profileData = checkedProfile(profile.data, patientId);
    } catch (problem) {
      profileError = errorText(problem);
    }
  }
  if (!reception && allergies.data && !allergies.loading && !allergyError) {
    try {
      allergyData = checkedAllergies(allergies.data, patientId);
    } catch (problem) {
      allergyError = errorText(problem);
    }
  }
  function start(kind: 'demographics' | 'allergies') {
    if (draft) {
      setOpen(true);
      return;
    }
    const common: DraftCommon = {
      patientId,
      requestId: crypto.randomUUID(),
      reason: '',
      phase: 'editing',
      attempt: null,
      error: '',
    };
    if (
      kind === 'demographics' &&
      profileData &&
      !patientView &&
      validRevision(profileData.revision)
    )
      setDraft({
        ...common,
        kind,
        source: profileData,
        values: { ...profileData.demographics },
        reviewed: null,
      });
    else if (
      kind === 'allergies' &&
      allergyData &&
      canWriteAllergies &&
      validRevision(allergyData.revision)
    )
      setDraft({
        ...common,
        kind,
        source: allergyData,
        values: { ...allergyData.current },
        reviewed: null,
      });
    else return;
    setOpen(true);
  }
  function saved(kind: CorrectionDraft['kind']) {
    if (!mounted.current) return;
    setDraft(null);
    setOpen(false);
    if (kind === 'demographics') {
      void profile.reload();
      toast('Patient details corrected. The login email is unchanged.');
    } else {
      void allergies.reload();
      toast('Allergy update saved and shared with the patient.');
    }
  }
  const returnTo = patientView
    ? '/my-care/record'
    : reception
      ? '/clinic/patients'
      : `/clinic/patients/${patientId}`;
  return (
    <div className="patient-profile-page">
      <Link className="back-link" to={returnTo}>
        <ArrowLeft size={15} />
        {reception ? 'Back to patients' : 'Back to health record'}
      </Link>
      <PageHeader
        eyebrow={patientView ? 'YOUR CURRENT RECORD' : 'PATIENT RECORD'}
        title="Patient details"
        description={
          profileData
            ? `${profileData.demographics.name} · Current contact details and recorded information`
            : 'Current patient details'
        }
        actions={
          <button
            className="button button-secondary"
            disabled={profile.loading || (!reception && allergies.loading)}
            onClick={() => {
              void profile.reload();
              if (!reception) void allergies.reload();
            }}
          >
            <RefreshCw size={15} />
            Refresh details
          </button>
        }
      />
      {draft && !open && (
        <div className="notice patient-profile-pending">
          <div>
            <strong>An update is unfinished.</strong>
            <p>
              Your {draft.kind === 'demographics' ? 'patient details correction' : 'allergy update'}{' '}
              is retained while this page stays open.
            </p>
          </div>
          <button className="button button-secondary" onClick={() => setOpen(true)}>
            Resume pending update
          </button>
        </div>
      )}
      <Card className="patient-profile-current">
        <div className="patient-profile-section-heading">
          <div>
            <h2>
              <UserRound size={19} />
              Contact & personal details
            </h2>
            <p>Current information used by the clinic to identify and contact the patient.</p>
          </div>
          {!patientView && (
            <button
              className="button button-secondary"
              disabled={!!draft || !profileData || !validRevision(profileData.revision)}
              onClick={() => start('demographics')}
            >
              <Pencil size={15} />
              Edit patient details
            </button>
          )}
        </div>
        {profile.loading ? (
          <Loading />
        ) : profileError ? (
          <ErrorState message={profileError} retry={profile.reload} />
        ) : profileData ? (
          <DemographicFacts values={profileData.demographics} />
        ) : (
          <EmptyState title="Patient details unavailable" />
        )}
        <p className="patient-profile-help">
          The contact email is part of the care record. Correcting it does not change the account’s
          login email or link another account. Existing visit notes, invoices and other historical
          records keep their original names and details.
        </p>
        {patientView && (
          <p className="notice">
            Ask your clinic to correct these details. You can read your current information here.
          </p>
        )}
      </Card>
      {!patientView && (
        <Card className="patient-profile-history">
          <div className="patient-profile-section-heading">
            <div>
              <h2>
                <History size={19} />
                Details correction history
              </h2>
              <p>Staff-only reasons and before/after values, newest first.</p>
            </div>
          </div>
          {profile.loading ? (
            <Loading />
          ) : profileError ? (
            <ErrorState message={profileError} retry={profile.reload} />
          ) : profileData?.changes.length ? (
            <div className="patient-profile-change-list">
              {profileData.changes.map((change) => (
                <article key={change.id} className="patient-profile-change">
                  <h3>
                    {change.createdByName} ·{' '}
                    {change.createdByRole === 'receptionist'
                      ? 'Reception'
                      : change.createdByRole === 'admin'
                        ? 'Administrator'
                        : 'Clinician'}
                  </h3>
                  <p className="patient-profile-stamp">{timestamp(change.createdAt)} IST</p>
                  <p className="patient-profile-reason">{change.reason}</p>
                  <details>
                    <summary>View before and after</summary>
                    <DemographicComparison before={change.before} after={change.after} />
                  </details>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No corrections recorded"
              description="New corrections preserve the previous values, the reason and the staff member who recorded the change."
            />
          )}
        </Card>
      )}
      {!reception && (
        <>
          <Card className="patient-allergy-current">
            <div className="patient-profile-section-heading">
              <div>
                <h2>
                  <ShieldCheck size={19} />
                  Allergy record
                </h2>
                <p>A clinician-maintained record, separate from demographic corrections.</p>
              </div>
              {canWriteAllergies && (
                <button
                  className="button button-secondary"
                  disabled={!!draft || !allergyData || !validRevision(allergyData.revision)}
                  onClick={() => start('allergies')}
                >
                  <Pencil size={15} />
                  Update allergy record
                </button>
              )}
            </div>
            {allergies.loading ? (
              <Loading />
            ) : allergyError ? (
              <ErrorState message={allergyError} retry={allergies.reload} />
            ) : allergyData ? (
              <AllergySnapshot values={allergyData.current} />
            ) : (
              <EmptyState title="Allergy record unavailable" />
            )}
            {patientView ? (
              <p className="notice">
                Tell your clinician about new or incorrect allergy information. Your clinician
                records updates and their reasons here.
              </p>
            ) : !canWriteAllergies ? (
              <p className="notice">
                A linked clinician account is required to change the allergy record.
              </p>
            ) : (
              <p className="patient-profile-help">
                Every update preserves the previous record. The patient can see its status, details,
                reason and clinician attribution immediately after saving.
              </p>
            )}
          </Card>
          <Card className="patient-allergy-history">
            <div className="patient-profile-section-heading">
              <div>
                <h2>
                  <History size={19} />
                  Allergy update history
                </h2>
                <p>These records and their reasons are shared with the patient.</p>
              </div>
            </div>
            {allergies.loading ? (
              <Loading />
            ) : allergyError ? (
              <ErrorState message={allergyError} retry={allergies.reload} />
            ) : allergyData?.changes.length ? (
              <div className="patient-profile-change-list">
                {allergyData.changes.map((change) => (
                  <article className="patient-allergy-change" key={change.id}>
                    <h3>{change.doctorName}</h3>
                    <p className="patient-profile-stamp">{timestamp(change.createdAt)} IST</p>
                    <div className="patient-profile-shared-reason">
                      <strong>Reason shared with patient</strong>
                      <p>{change.reason}</p>
                    </div>
                    <details>
                      <summary>View before and after</summary>
                      <div className="patient-allergy-comparison">
                        <section>
                          <h4>Before</h4>
                          <AllergySnapshot values={change.before} />
                        </section>
                        <section>
                          <h4>After</h4>
                          <AllergySnapshot values={change.after} />
                        </section>
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No allergy updates recorded"
                description="Current information may come from the original registration. This history does not invent an earlier review or clinician attribution."
              />
            )}
          </Card>
        </>
      )}
      {draft && open && (
        <CorrectionModal
          draft={draft}
          onChange={setDraft}
          onClose={() => setOpen(false)}
          onDiscard={() => {
            setDraft(null);
            setOpen(false);
          }}
          onSaved={saved}
        />
      )}
    </div>
  );
}

function DemographicFacts({ values }: { values: PatientDemographics }) {
  return (
    <dl className="patient-profile-facts">
      {demographicFields.map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{displayValue(key, values[key])}</dd>
        </div>
      ))}
    </dl>
  );
}
function DemographicComparison({
  before,
  after,
}: {
  before: PatientDemographics;
  after: PatientDemographics;
}) {
  return (
    <div
      className="patient-profile-comparison"
      role="region"
      aria-label="Patient details before and after; scroll horizontally for all columns"
      tabIndex={0}
    >
      <table>
        <caption>Recorded patient details</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {demographicFields.map(([key, label]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td>{displayValue(key, before[key])}</td>
              <td>{displayValue(key, after[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function AllergySnapshot({ values }: { values: PatientAllergies }) {
  return (
    <div className="patient-allergy-snapshot">
      <Badge
        tone={
          values.status === 'recorded'
            ? 'amber'
            : values.status === 'not-recorded'
              ? 'neutral'
              : 'blue'
        }
      >
        {allergyLabels[values.status]}
      </Badge>
      {values.status === 'recorded' ? (
        <p>{values.text}</p>
      ) : values.status === 'not-recorded' ? (
        <p className="patient-profile-help">
          Allergy information has not been recorded. This is different from a record of no known
          allergies.
        </p>
      ) : (
        <p className="patient-profile-help">
          The current record states that no allergies are known.
        </p>
      )}
    </div>
  );
}

function CorrectionModal({
  draft,
  onChange,
  onClose,
  onDiscard,
  onSaved,
}: {
  draft: CorrectionDraft;
  onChange: (draft: CorrectionDraft) => void;
  onClose: () => void;
  onDiscard: () => void;
  onSaved: (kind: CorrectionDraft['kind']) => void;
}) {
  const [busy, setBusy] = useState(false);
  const locked = busy || draft.phase !== 'editing';
  const changed =
    draft.kind === 'demographics'
      ? JSON.stringify(normalizeDemographics(draft.values)) !==
        JSON.stringify(draft.source.demographics)
      : JSON.stringify(normalizeAllergies(draft.values)) !== JSON.stringify(draft.source.current);
  const path = `/api/patients/${draft.patientId}/${draft.kind === 'demographics' ? 'profile' : 'allergies'}`;
  function changeDemographics(key: keyof PatientDemographics, value: string) {
    if (draft.kind === 'demographics')
      onChange({ ...draft, values: { ...draft.values, [key]: value } });
  }
  function changeAllergies(key: keyof PatientAllergies, value: string) {
    if (draft.kind === 'allergies')
      onChange({ ...draft, values: { ...draft.values, [key]: value } });
  }
  function buildAttempt(): Attempt {
    if (!draft.reason.trim()) throw new Error('Enter a reason for this update.');
    if (!changed) throw new Error('Change at least one value before saving an update.');
    const common = {
      reason: draft.reason.trim(),
      expectedRevision: draft.source.revision,
      requestId: draft.requestId,
    };
    if (draft.kind === 'demographics') {
      const values = normalizeDemographics(draft.values);
      if (!values.name) throw new Error('Enter the patient’s full name.');
      if (values.phone.length < 7 || values.phone.length > 30)
        throw new Error('Enter a phone number from 7 to 30 characters.');
      if (
        values.dob &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(values.dob) ||
          !Number.isFinite(Date.parse(`${values.dob}T12:00:00Z`)) ||
          new Date(`${values.dob}T12:00:00Z`).toISOString().slice(0, 10) !== values.dob ||
          values.dob > today())
      )
        throw new Error(
          'Choose a real date of birth that is not in the future, or leave it blank.',
        );
      return { path, method: 'PATCH', body: { ...values, ...common } };
    }
    const values = normalizeAllergies(draft.values);
    if (values.status === 'recorded' && !values.text)
      throw new Error('Describe the recorded allergy information.');
    return { path, method: 'POST', body: { ...values, ...common } };
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || draft.phase === 'conflict') return;
    let attempt: Attempt;
    try {
      attempt = draft.attempt ?? buildAttempt();
    } catch (problem) {
      onChange({ ...draft, error: errorText(problem) });
      return;
    }
    const pending = { ...draft, attempt, error: '' };
    onChange(pending);
    setBusy(true);
    try {
      const result = await api<unknown>(attempt.path, {
        method: attempt.method,
        body: attempt.body,
      });
      if (draft.kind === 'demographics') checkedProfile(result, draft.patientId, true);
      else checkedAllergies(result, draft.patientId, true);
      onSaved(draft.kind);
    } catch (problem) {
      const error = errorText(problem);
      if (problem instanceof ApiError && [400, 403, 404, 422].includes(problem.status))
        onChange({ ...draft, attempt: null, phase: 'editing', error });
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/correction request was already used/i.test(error)
      )
        onChange({ ...pending, phase: 'conflict', reviewed: null, error });
      else onChange({ ...pending, phase: 'uncertain', error });
    } finally {
      setBusy(false);
    }
  }
  async function refreshLatest() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<unknown>(path);
      if (draft.kind === 'demographics')
        onChange({ ...draft, reviewed: checkedProfile(result, draft.patientId, true), error: '' });
      else
        onChange({
          ...draft,
          reviewed: checkedAllergies(result, draft.patientId, true),
          error: '',
        });
    } catch (problem) {
      onChange({ ...draft, error: errorText(problem) });
    } finally {
      setBusy(false);
    }
  }
  function acceptLatest() {
    if (busy) return;
    if (draft.kind === 'demographics' && draft.reviewed)
      onChange({
        ...draft,
        source: draft.reviewed,
        requestId: crypto.randomUUID(),
        attempt: null,
        phase: 'editing',
        reviewed: null,
        error: '',
      });
    if (draft.kind === 'allergies' && draft.reviewed)
      onChange({
        ...draft,
        source: draft.reviewed,
        requestId: crypto.randomUUID(),
        attempt: null,
        phase: 'editing',
        reviewed: null,
        error: '',
      });
  }
  return (
    <Modal
      title={draft.kind === 'demographics' ? 'Correct patient details' : 'Update allergy record'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack patient-profile-form" onSubmit={save}>
        {draft.error && (
          <p className="notice notice-error" role="alert">
            {draft.error}
          </p>
        )}
        {draft.kind === 'demographics' ? (
          <>
            <p className="patient-profile-help">
              Changes update the current patient record. The login email, portal account link and
              existing historical records remain unchanged. Your correction reason is visible to
              staff.
            </p>
            <div className="patient-profile-form-grid">
              <Field label="Full name">
                <input
                  required
                  maxLength={300}
                  value={draft.values.name}
                  disabled={locked}
                  onChange={(event) => changeDemographics('name', event.target.value)}
                />
              </Field>
              <Field
                label="Contact email"
                hint="Optional care-record email; this is not the account’s login email."
              >
                <input
                  type="email"
                  maxLength={254}
                  value={draft.values.email}
                  disabled={locked}
                  onChange={(event) => changeDemographics('email', event.target.value)}
                />
              </Field>
              <Field label="Phone number">
                <input
                  required
                  type="tel"
                  minLength={7}
                  maxLength={30}
                  value={draft.values.phone}
                  disabled={locked}
                  onChange={(event) => changeDemographics('phone', event.target.value)}
                />
              </Field>
              <Field label="Date of birth" hint="Leave blank when not recorded.">
                <input
                  type="date"
                  max={today()}
                  value={draft.values.dob}
                  disabled={locked}
                  onChange={(event) => changeDemographics('dob', event.target.value)}
                />
              </Field>
              <Field label="Gender">
                <input
                  maxLength={50}
                  value={draft.values.gender}
                  disabled={locked}
                  onChange={(event) => changeDemographics('gender', event.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Reason for correction"
              hint="Staff-only context. Do not include clinical information in a demographic correction."
            >
              <textarea
                required
                maxLength={1000}
                rows={3}
                value={draft.reason}
                disabled={locked}
                onChange={(event) => onChange({ ...draft, reason: event.target.value })}
              />
            </Field>
          </>
        ) : (
          <>
            <div className="notice">
              This update, its reason and your clinician attribution are shared with the patient
              immediately after saving.
            </div>
            <Field label="Allergy status">
              <select
                value={draft.values.status}
                disabled={locked}
                onChange={(event) => changeAllergies('status', event.target.value)}
              >
                {Object.entries(allergyLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {draft.values.status === 'recorded' ? (
              <Field
                label="Allergy details"
                hint="Record the information supplied or confirmed during care; do not infer an allergy automatically."
              >
                <textarea
                  required
                  rows={5}
                  maxLength={8000}
                  disabled={locked}
                  value={draft.values.text}
                  onChange={(event) => changeAllergies('text', event.target.value)}
                />
              </Field>
            ) : (
              <p className="patient-profile-help">
                This status saves without allergy details. Previous details remain preserved in the
                update history.
              </p>
            )}
            <Field
              label="Reason shared with patient"
              hint="Explain what changed and why in language the patient can read."
            >
              <textarea
                required
                rows={3}
                maxLength={1000}
                disabled={locked}
                value={draft.reason}
                onChange={(event) => onChange({ ...draft, reason: event.target.value })}
              />
            </Field>
          </>
        )}
        {!changed && draft.phase === 'editing' && (
          <p className="patient-profile-help">
            Change at least one recorded value to save an update. A reason alone does not create a
            new history entry.
          </p>
        )}
        {draft.phase === 'uncertain' && (
          <div className="notice patient-profile-retry">
            <strong>The save outcome could not be confirmed.</strong>
            <p>
              Your exact submitted update and request ID are preserved. Retry the same request to
              check its outcome without applying it twice.
            </p>
          </div>
        )}
        {draft.phase === 'conflict' && (
          <div className="notice patient-profile-conflict">
            <strong>The current record needs review before saving.</strong>
            <p>
              Your draft and reason are preserved. Refresh this record to see changes made since you
              opened the form.
            </p>
            {draft.reviewed ? (
              <>
                <h3>Latest record and your draft</h3>
                {draft.kind === 'demographics' ? (
                  <DemographicComparison
                    before={draft.reviewed.demographics}
                    after={normalizeDemographics(draft.values)}
                  />
                ) : (
                  <div className="patient-allergy-comparison">
                    <section>
                      <h4>Latest record</h4>
                      <AllergySnapshot values={draft.reviewed.current} />
                    </section>
                    <section>
                      <h4>Your draft</h4>
                      <AllergySnapshot values={normalizeAllergies(draft.values)} />
                    </section>
                  </div>
                )}
                <p>
                  The current draft will be used as shown. Keep it to make any further edits and
                  prepare a new request; nothing changes until you save again.
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={acceptLatest}
                >
                  I reviewed the latest record; keep my draft
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={refreshLatest}
              >
                {draft.kind === 'demographics'
                  ? 'Refresh latest details'
                  : 'Refresh allergy record'}
              </button>
            )}
          </div>
        )}
        <div className="patient-profile-modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Close for now
          </button>
          {draft.phase === 'editing' && !draft.attempt && (
            <button
              type="button"
              className="button button-ghost"
              disabled={busy}
              onClick={onDiscard}
            >
              Cancel draft
            </button>
          )}
          <button
            className="button button-primary"
            disabled={busy || draft.phase === 'conflict' || (draft.phase === 'editing' && !changed)}
          >
            {busy
              ? 'Saving…'
              : draft.phase === 'uncertain'
                ? 'Retry same request'
                : draft.kind === 'demographics'
                  ? 'Save patient details'
                  : 'Save allergy update'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import type { CarePlanFields, CreatedCarePlan } from '../../shared/care-plan-creation';
import type { Medication, Patient, Session } from '../../shared/types';
import { api, shiftDate, today, useSession } from '../lib';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import {
  carePlanNotCreated,
  confirmedCarePlan,
  linkedDoctor,
  medicationKeys,
  medicationLabels,
  planKeys,
  planLabels,
  reviewedFields,
  type CarePlanAttempt,
} from './care-plan-creation-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { ErrorState, Field, Loading, Modal } from './ui';
import './care-plan-creation.css';

function PlanSummary({
  fields,
  doctorName,
  patientName,
}: {
  fields: CarePlanFields;
  doctorName: string;
  patientName: string;
}) {
  return (
    <>
      <p>
        For <strong>{patientName}</strong> · Clinician <strong>{doctorName}</strong>
      </p>
      <dl className="care-plan-summary">
        {planKeys.map((key) => (
          <div key={key}>
            <dt>{planLabels[key]}</dt>
            <dd>{fields[key] || 'Not provided'}</dd>
          </div>
        ))}
      </dl>
      <h3>Medications / treatment steps</h3>
      {fields.medications.length ? (
        fields.medications.map((item, index) => (
          <section key={index} className="medication-editor">
            <h4>Item {index + 1}</h4>
            <dl className="care-plan-summary">
              {medicationKeys.map((key) => (
                <div key={key}>
                  <dt>{medicationLabels[key]}</dt>
                  <dd>{item[key] || 'Not provided'}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))
      ) : (
        <p>No treatment items added.</p>
      )}
    </>
  );
}

export function CarePlanModal({
  patient,
  onClose,
}: {
  patient: Pick<Patient, 'id' | 'name'>;
  onClose: (created: boolean) => void;
}) {
  const { session } = useSession();
  const { plans } = usePendingCareSubmissions();
  const capture = useAppointmentBookingGuard();
  const pending = plans.get(patient.id);
  const [phase, setPhase] = useState<'edit' | 'review' | 'pending' | 'rejected' | 'saved'>(
    pending ? 'pending' : 'edit',
  );
  const [doctorId, setDoctorId] = useState(
    pending?.command.doctorId ?? session.user?.doctorId ?? '',
  );
  const doctors = useAppointmentBookingData(phase === 'edit' ? '/api/doctors' : null, (value) =>
    linkedDoctor(value, doctorId),
  );
  const [names, setNames] = useState({
    patientName: pending?.patientName ?? patient.name,
    doctorName: pending?.doctorName ?? '',
  });
  const [draft, setDraft] = useState<CarePlanFields>(() => {
    if (pending) return pending.command;
    const startDate = today();
    return {
      title: '',
      instructions: '',
      expectations: '',
      warnings: '',
      cost: '',
      startDate,
      endDate: shiftDate(startDate, 30),
      followUpDate: shiftDate(startDate, 14),
      medications: [],
    };
  });
  const [reviewed, setReviewed] = useState(false);
  const [saved, setSaved] = useState<CreatedCarePlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const open = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (phase === 'review' || phase === 'saved' || phase === 'rejected') heading.current?.focus();
  }, [phase]);
  function close() {
    open.current = false;
    onClose(!!saved);
  }
  function update(key: Exclude<keyof CarePlanFields, 'medications'>, value: string) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError('');
  }
  function setMedications(medications: Medication[]) {
    setDraft((previous) => ({ ...previous, medications }));
    setError('');
  }
  function editMedication(index: number, field: keyof Medication, value: string) {
    setMedications(
      draft.medications.map((item, i) => (index === i ? { ...item, [field]: value } : item)),
    );
  }
  function review(event: FormEvent) {
    event.preventDefault();
    if (phase !== 'edit' || !doctors.data || !doctorId) return;
    try {
      setDraft(reviewedFields(draft));
      setNames({ patientName: patient.name, doctorName: doctors.data.name });
      setReviewed(false);
      setError('');
      setPhase('review');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Check the care plan and try again.');
    }
  }
  async function create() {
    const actorId = session.user?.id;
    if (
      working.current ||
      !actorId ||
      !(phase === 'pending' ? pending : phase === 'review' && reviewed)
    )
      return;
    const attempt: CarePlanAttempt = pending ?? {
      ...names,
      command: {
        ...draft,
        patientId: patient.id,
        doctorId,
        reviewedConfirmed: true,
        requestId: crypto.randomUUID(),
      },
    };
    const origin = capture();
    const current = () => open.current && origin() && plans.get(patient.id) === attempt;
    plans.set(patient.id, attempt);
    working.current = true;
    setBusy(true);
    setPhase('pending');
    setError('');
    try {
      const result = await api<unknown>('/api/care-plans/create', {
        method: 'POST',
        body: attempt.command,
        isCurrent: current,
      });
      if (!current()) return;
      const plan = confirmedCarePlan(result, attempt.command, actorId);
      if (!plan) return;
      plans.delete(patient.id);
      setSaved(plan);
      setPhase('saved');
    } catch (problem) {
      if (current() && carePlanNotCreated(problem, attempt.command, actorId)) {
        plans.delete(patient.id);
        setReviewed(false);
        setPhase('rejected');
      }
    } finally {
      if (open.current && origin()) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  async function reviewRejected() {
    if (working.current) return;
    const origin = capture();
    const current = () => open.current && origin();
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const fresh = await api<Session>('/api/session', { isCurrent: current });
      if (!current()) return;
      const user = fresh?.user;
      if (
        !user ||
        user.id !== session.user?.id ||
        !['admin', 'doctor'].includes(user.role) ||
        !user.doctorId ||
        user.mustChangePassword ||
        user.active === false ||
        fresh.csrfToken !== session.csrfToken
      )
        throw new Error('A current linked clinician account is required to review this draft.');
      setDoctorId(user.doctorId);
      setPhase('edit');
    } catch (problem) {
      if (current())
        setError(
          problem instanceof Error
            ? problem.message
            : 'Could not refresh the linked clinician. Try again.',
        );
    } finally {
      if (current()) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  let content;
  if (phase === 'edit') {
    content = (
      <form className="stack" onSubmit={review}>
        {doctors.loading ? (
          <Loading />
        ) : doctors.error ? (
          <ErrorState message={doctors.error} retry={doctors.reload} />
        ) : (
          <p>
            For <strong>{patient.name}</strong> · Clinician <strong>{doctors.data?.name}</strong>
          </p>
        )}
        <Field label="Plan title">
          <input
            name="title"
            value={draft.title}
            onChange={(e) => update('title', e.target.value)}
            required
            maxLength={200}
            placeholder="A clear name for this treatment journey"
          />
        </Field>
        <Field label="Instructions">
          <textarea
            name="instructions"
            value={draft.instructions}
            onChange={(e) => update('instructions', e.target.value)}
            required
            rows={3}
            maxLength={8000}
            placeholder="Explain the plan in language the patient can understand"
          />
        </Field>
        <div className="form-grid">
          <Field label="Start date">
            <input
              name="startDate"
              value={draft.startDate}
              onChange={(e) => update('startDate', e.target.value)}
              required
              type="date"
            />
          </Field>
          <Field label="End / review date">
            <input
              name="endDate"
              value={draft.endDate}
              onChange={(e) => update('endDate', e.target.value)}
              required
              type="date"
              min={draft.startDate}
            />
          </Field>
          <Field label="Follow-up date">
            <input
              name="followUpDate"
              value={draft.followUpDate}
              onChange={(e) => update('followUpDate', e.target.value)}
              required
              type="date"
              min={draft.startDate}
            />
          </Field>
          <Field label="Expected cost">
            <input
              name="cost"
              value={draft.cost}
              onChange={(e) => update('cost', e.target.value)}
              maxLength={200}
              placeholder="e.g. ₹800–1,200, confirmed with patient"
            />
          </Field>
        </div>
        <Field label="What to expect">
          <textarea
            name="expectations"
            value={draft.expectations}
            onChange={(e) => update('expectations', e.target.value)}
            rows={2}
            maxLength={5000}
            placeholder="Expected duration, review points and realistic expectations"
          />
        </Field>
        <Field label="Precautions and when to contact the clinic">
          <textarea
            name="warnings"
            value={draft.warnings}
            onChange={(e) => update('warnings', e.target.value)}
            rows={2}
            required
            maxLength={5000}
            placeholder="Specific clinician-reviewed warnings and escalation instructions"
          />
        </Field>
        <div className="row between">
          <h3 className="section-title">Medications / treatment steps</h3>
          <button
            type="button"
            className="button button-secondary button-small"
            disabled={draft.medications.length >= 30}
            onClick={() =>
              setMedications([
                ...draft.medications,
                { name: '', instructions: '', schedule: '', duration: '', warnings: '' },
              ])
            }
          >
            <Plus size={14} /> Add item
          </button>
        </div>
        {draft.medications.length === 0 && (
          <p className="muted small">
            Add prescribed medications if applicable. No automated medication recommendations are
            generated.
          </p>
        )}
        {draft.medications.map((m, index) => (
          <div className="medication-editor" key={index}>
            <div className="row between">
              <strong>Item {index + 1}</strong>
              <button
                className="button button-ghost button-small"
                type="button"
                aria-label={`Remove medication ${index + 1}`}
                onClick={() => setMedications(draft.medications.filter((_, i) => i !== index))}
              >
                <X size={16} />
              </button>
            </div>
            <Field label="Medication / treatment name">
              <input
                required
                maxLength={200}
                value={m.name}
                onChange={(e) => editMedication(index, 'name', e.target.value)}
              />
            </Field>
            <Field label="Dose and instructions">
              <textarea
                required
                rows={2}
                maxLength={2000}
                value={m.instructions}
                onChange={(e) => editMedication(index, 'instructions', e.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field label="Schedule">
                <input
                  required
                  maxLength={200}
                  value={m.schedule}
                  onChange={(e) => editMedication(index, 'schedule', e.target.value)}
                  placeholder="As prescribed"
                />
              </Field>
              <Field label="Duration">
                <input
                  required
                  maxLength={200}
                  value={m.duration}
                  onChange={(e) => editMedication(index, 'duration', e.target.value)}
                />
              </Field>
            </div>
            <Field label="Item-specific warnings">
              <input
                maxLength={2000}
                value={m.warnings}
                onChange={(e) => editMedication(index, 'warnings', e.target.value)}
              />
            </Field>
          </div>
        ))}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={close}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!doctors.data}>
            Review care plan
          </button>
        </div>
      </form>
    );
  } else if (phase === 'saved' && saved) {
    content = (
      <div className="stack">
        <h3 ref={heading} tabIndex={-1}>
          Care plan shared
        </h3>
        <p>
          Originally shared on{' '}
          <time dateTime={saved.createdAt}>
            {new Date(saved.createdAt).toLocaleString('en-IN', {
              timeZone: 'Asia/Kolkata',
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            IST
          </time>{' '}
          as an active plan.
        </p>
        <PlanSummary fields={saved} doctorName={saved.doctorName} patientName={saved.patientName} />
        <div className="modal-actions">
          <button type="button" className="button button-primary" onClick={close}>
            Close care plan
          </button>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="stack">
        {phase === 'rejected' ? (
          <div className="notice" role="alert">
            <h3 ref={heading} tabIndex={-1}>
              Care plan was not created
            </h3>
            <p>
              Your linked clinician profile changed. Review the draft with your current profile
              before sharing.
            </p>
          </div>
        ) : phase === 'pending' ? (
          <div className="notice" role="status">
            <strong>{busy ? 'Sharing care plan…' : 'Care plan creation unconfirmed'}</strong>
            <p>
              Retry the exact creation to recover its confirmation. You can close and resume it in
              this signed-in tab. Reloading or signing out clears the retry details.
            </p>
          </div>
        ) : (
          <h3 ref={heading} tabIndex={-1}>
            Review care plan
          </h3>
        )}
        <PlanSummary fields={pending?.command ?? draft} {...names} />
        {phase === 'review' && (
          <label className="care-plan-acknowledgment">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />{' '}
            I reviewed this care plan and confirm it is ready to share.
          </label>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {phase === 'review' ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setReviewed(false);
                setPhase('edit');
              }}
            >
              Edit plan
            </button>
          ) : (
            <button type="button" className="button button-secondary" onClick={close}>
              Close care plan
            </button>
          )}
          {phase === 'rejected' ? (
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={reviewRejected}
            >
              Review draft
            </button>
          ) : (
            <button
              type="button"
              className="button button-primary"
              disabled={busy || (phase === 'review' && !reviewed)}
              onClick={create}
            >
              {busy
                ? 'Sharing…'
                : phase === 'pending'
                  ? 'Retry exact creation'
                  : 'Save and share care plan'}
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <Modal title="Create a care plan" onClose={close}>
      <div className="care-plan-creation">{content}</div>
    </Modal>
  );
}

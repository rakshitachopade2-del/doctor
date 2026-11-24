import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { ProcedureRecord } from '../../shared/clinical';
import type { Appointment } from '../../shared/types';
import type {
  ProcedureCreateMutation,
  ProcedureTemplateDetail,
} from '../../shared/procedure-catalogue';
import { api, formatDate, useSession, useToast } from '../lib';
import { EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { checkedTemplateDetail, checkedTemplatePage } from './procedure-catalogue-helpers';
import {
  checkedProcedureCreation,
  checkedPlanRefusal,
  procedureFailure,
  procedureFieldLabels,
  procedureFieldNames,
  templateSelection,
  type ProcedurePlanAttempt,
  type ProcedurePlanBody,
  type ProcedurePlanDraft,
} from './procedure-plan-helpers';
import './procedure-plan.css';
import './patient-registration.css';

const emptyDraft: ProcedurePlanDraft = {
  title: '',
  benefits: '',
  risks: '',
  alternatives: '',
  aftercare: '',
  estimatedCost: '',
  indication: '',
  appointmentId: '',
};
function TemplateContent({ source }: { source: ProcedureTemplateDetail }) {
  const version = source.publishedVersion;
  return (
    <>
      <h4>{version?.fields.title ?? source.template.title}</h4>
      <p>
        {version ? `Published version ${version.version}` : 'No published version'} ·{' '}
        {source.template.active ? 'Active' : 'Archived'}
      </p>
      {version && (
        <dl>
          {procedureFieldNames
            .filter((key) => key !== 'title')
            .map((key) => (
              <div key={key}>
                <dt>{procedureFieldLabels[key]}</dt>
                <dd>{version.fields[key] || 'No estimate recorded.'}</dd>
              </div>
            ))}
        </dl>
      )}
    </>
  );
}
const appointmentLabel = (visit: Appointment) =>
  formatDate(visit.date) +
  ' · ' +
  visit.time +
  ' IST · ' +
  (visit.durationMinutes ?? 30) +
  ' minutes · ' +
  visit.doctorName +
  ' · ' +
  visit.reason;

export function useProcedurePlan(
  patientId: string,
  patientName: string,
  appointments: Appointment[],
  procedures: ProcedureRecord[],
  reload: () => void,
) {
  const { session } = useSession(),
    user = session.user,
    { key } = useLocation();
  const { procedurePlans } = usePendingCareSubmissions();
  const scope = JSON.stringify([
    key,
    patientId,
    user?.id,
    user?.role,
    user?.doctorId,
    session.csrfToken,
  ]);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => setOpen(false), [scope]);
  if (
    !user?.doctorId ||
    user.mustChangePassword ||
    (user.role !== 'doctor' && user.role !== 'admin')
  )
    return { button: null, modal: null, hasPending: false };
  const hasPending = procedurePlans.has(patientId);
  return {
    hasPending,
    button: (
      <button className="button button-primary" onClick={() => setOpen(true)}>
        <Plus size={16} />
        {hasPending ? 'Resume procedure plan' : 'Plan procedure'}
      </button>
    ),
    modal: open && (
      <ProcedurePlanModal
        key={scope}
        patientId={patientId}
        patientName={patientName}
        appointments={appointments}
        procedures={procedures}
        actorId={user.id}
        doctorId={user.doctorId}
        role={user.role}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          reload();
        }}
      />
    ),
  };
}

function ProcedurePlanModal({
  patientId,
  patientName,
  actorId,
  doctorId,
  role,
  procedures,
  appointments,
  onClose,
  onSaved,
}: {
  patientId: string;
  patientName: string;
  doctorId: string;
  actorId: string;
  role: ProcedurePlanBody['plannedByRole'];
  procedures: ProcedureRecord[];
  appointments: Appointment[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast(),
    capture = useAppointmentBookingGuard();
  const { procedurePlans } = usePendingCareSubmissions();
  const [attempt, setAttempt] = useState<ProcedurePlanAttempt | null>(
    () => procedurePlans.get(patientId) ?? null,
  );
  const [draft, setDraft] = useState<ProcedurePlanDraft>(() =>
    attempt
      ? {
          title: attempt.body.title,
          benefits: attempt.body.benefits,
          risks: attempt.body.risks,
          alternatives: attempt.body.alternatives,
          aftercare: attempt.body.aftercare,
          estimatedCost: attempt.body.estimatedCost,
          indication: attempt.body.indication,
          appointmentId: attempt.body.appointmentId ?? '',
        }
      : emptyDraft,
  );
  const [picker, setPicker] = useState(false),
    [search, setSearch] = useState('');
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [selectedId, setSelectedId] = useState('');
  const [source, setSource] = useState<ProcedureTemplateDetail | null>(attempt?.source ?? null);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false),
    [patientReviewed, setPatientReviewed] = useState(!!attempt?.source);
  const [phase, setPhase] = useState<'editing' | 'saving' | 'uncertain' | 'conflict'>(
    attempt ? 'uncertain' : 'editing',
  );
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<ProcedureCreateMutation | null>(null);
  const [refreshed, setRefreshed] = useState<ProcedureTemplateDetail | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const dismissed = useRef(false),
    pending = useRef(false),
    refreshId = useRef(0);
  const filters = { search: query, active: 'true' as const, publication: 'published' as const };
  const list = useAppointmentBookingData(
    picker
      ? `/api/procedure-catalogue?${new URLSearchParams({ ...filters, page: String(page), pageSize: '10' })}`
      : null,
    (value) => checkedTemplatePage(value, filters, page, 10),
  );
  const preview = useAppointmentBookingData(
    picker && selectedId ? `/api/procedure-catalogue/${encodeURIComponent(selectedId)}` : null,
    (value) => checkedTemplateDetail(value, selectedId),
  );
  const locked = phase !== 'editing' || refreshing;
  function close() {
    dismissed.current = true;
    if (saved) onSaved();
    else onClose();
  }
  function edit(key: keyof ProcedurePlanDraft, value: string) {
    setDraft((old) => ({ ...old, [key]: value }));
    setPatientReviewed(false);
  }
  function chooseTemplate() {
    const value = preview.data;
    if (locked || !value?.template.active || !value.publishedVersion) return;
    if (procedureFieldNames.some((key) => !!draft[key].trim()) && !replacementConfirmed) return;
    setDraft((old) => ({ ...old, ...value.publishedVersion!.fields }));
    setSource(value);
    setPatientReviewed(false);
    setReplacementConfirmed(false);
    setPicker(false);
    setError('');
  }
  function detach() {
    if (pending.current || phase === 'uncertain') return;
    setSource(null);
    setRefreshed(null);
    setAttempt(null);
    setPhase('editing');
    setPatientReviewed(false);
    setError('');
  }
  async function refreshSource() {
    if (!source || refreshing || pending.current) return;
    const request = ++refreshId.current;
    const origin = capture();
    const current = () => origin() && !dismissed.current && request === refreshId.current;
    setRefreshing(true);
    setRefreshed(null);
    setError('');
    try {
      const value = checkedTemplateDetail(
        await api(`/api/procedure-catalogue/${encodeURIComponent(source.template.id)}`, {
          isCurrent: current,
        }),
        source.template.id,
      );
      if (current()) setRefreshed(value);
    } catch (problem) {
      if (current()) setError(procedureFailure(problem));
    } finally {
      if (current()) setRefreshing(false);
    }
  }
  function acceptRefreshed() {
    if (!refreshed?.template.active || !refreshed.publishedVersion || refreshing) return;
    setSource(refreshed);
    setRefreshed(null);
    setAttempt(null);
    setPhase('editing');
    setPatientReviewed(false);
    setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current || refreshing || dismissed.current || phase === 'conflict') return;
    const recovering =
      phase === 'uncertain' && attempt !== null && procedurePlans.get(patientId) === attempt;
    if (
      !recovering &&
      (phase !== 'editing' || procedurePlans.has(patientId) || (source && !patientReviewed))
    )
      return;
    if (
      !recovering &&
      ['indication', ...procedureFieldNames.filter((k) => k !== 'estimatedCost')].some(
        (k) => !draft[k as keyof ProcedurePlanDraft].trim(),
      )
    ) {
      setError('Enter the procedure name, indication and each discussion field before saving.');
      return;
    }
    const body: ProcedurePlanBody = {
      title: draft.title.trim(),
      benefits: draft.benefits.trim(),
      risks: draft.risks.trim(),
      alternatives: draft.alternatives.trim(),
      aftercare: draft.aftercare.trim(),
      estimatedCost: draft.estimatedCost.trim(),
      indication: draft.indication.trim(),
      patientId,
      appointmentId: draft.appointmentId || null,
      requestId: crypto.randomUUID(),
      doctorId,
      plannedByRole: role,
      ...(source
        ? { templateSelection: templateSelection(source), reviewedForPatient: true as const }
        : {}),
    };
    const visit = appointments.find((a) => a.id === body.appointmentId);
    const sent = attempt ?? {
      body,
      source,
      actorId,
      patientName,
      priorIds: procedures.map((p) => p.id),
      appointmentLabel: visit
        ? appointmentLabel(visit)
        : (body.appointmentId ?? 'No linked appointment'),
    };
    pending.current = true;
    procedurePlans.set(patientId, sent);
    const origin = capture();
    const current = () => origin() && !dismissed.current && procedurePlans.get(patientId) === sent;
    setAttempt(sent);
    setPhase('saving');
    setError('');
    try {
      const response = await api('/api/procedures', {
        method: 'POST',
        body: sent.body,
        isCurrent: current,
      });
      if (!current()) return;
      const confirmed = checkedProcedureCreation(response, sent);
      procedurePlans.delete(patientId);
      if (recovering) setSaved(confirmed);
      else {
        toast('Procedure plan saved. Plan ID · ' + confirmed.procedure.id);
        onSaved();
      }
    } catch (problem) {
      if (!current()) return;
      const refusal = checkedPlanRefusal(problem, sent);
      if (refusal) {
        procedurePlans.delete(patientId);
        setAttempt(null);
        setPatientReviewed(false);
        setRefreshed(null);
        if (refusal.field === 'appointment') setDraft((old) => ({ ...old, appointmentId: '' }));
        setPhase(refusal.field === 'template' ? 'conflict' : 'editing');
        setError(refusal.message);
      } else {
        setPhase('uncertain');
        setError(
          'The save outcome could not be confirmed. Retry the same request to recover the original plan or submit it if the first request never arrived.',
        );
      }
    } finally {
      pending.current = false;
    }
  }
  if (saved && attempt) {
    const plan = saved.procedure;
    return (
      <Modal title="Procedure plan confirmed" onClose={close}>
        <div className="stack patient-registration">
          <dl className="registration-details">
            <div>
              <dt>Plan ID</dt>
              <dd>{plan.id}</dd>
            </div>
            <div>
              <dt>Patient</dt>
              <dd>
                {attempt.patientName} · {patientId}
              </dd>
            </div>
            <div>
              <dt>Planning clinician</dt>
              <dd>
                {plan.doctorName} · {plan.doctorId}
              </dd>
            </div>
            <div>
              <dt>Originally linked appointment</dt>
              <dd>{plan.appointmentId ?? 'No linked appointment'}</dd>
            </div>
            <div>
              <dt>Indication / reason</dt>
              <dd>{plan.indication}</dd>
            </div>
            {procedureFieldNames.map((key) => (
              <div key={key}>
                <dt>{procedureFieldLabels[key]}</dt>
                <dd>{plan[key] || 'No estimate recorded.'}</dd>
              </div>
            ))}
            {plan.templateSource && (
              <div>
                <dt>Template at creation</dt>
                <dd>
                  {plan.templateSource.templateTitle} · Version {plan.templateSource.version}
                </dd>
              </div>
            )}
            <div>
              <dt>Status at creation</dt>
              <dd>Planned</dd>
            </div>
          </dl>
          <button className="button button-primary" onClick={close}>
            Done
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Plan a procedure" onClose={close}>
      <p>
        For <strong>{attempt?.patientName ?? patientName}</strong> · {patientId}
      </p>
      <p className="muted">
        Write a patient-specific plan, or start from a published clinic template. Review every field
        before saving.
      </p>
      <button
        className="button button-secondary"
        type="button"
        disabled={locked}
        onClick={() => setPicker(!picker)}
      >
        {picker ? 'Hide procedure templates' : 'Choose a published template'}
      </button>
      {picker && (
        <section className="procedure-template-picker" aria-label="Published procedure templates">
          <form
            className="procedure-template-search"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(search.trim());
              setPage(1);
              setSelectedId('');
              setReplacementConfirmed(false);
            }}
          >
            <Field label="Search procedure templates">
              <input
                maxLength={300}
                value={search}
                disabled={locked}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
            <button className="button button-secondary" disabled={locked}>
              Search templates
            </button>
          </form>
          {list.loading ? (
            <Loading />
          ) : list.error ? (
            <ErrorState message={list.error} retry={list.reload} />
          ) : (
            list.data && (
              <>
                {list.data.items.length ? (
                  <div className="procedure-template-results">
                    {list.data.items.map((row) => (
                      <article className="procedure-template-option" key={row.id}>
                        <h4>{row.publishedTitle}</h4>
                        <p>Published version {row.publishedVersion}</p>
                        {row.latestVersion !== row.publishedVersion && (
                          <p className="muted small">
                            A newer draft is not included in this selection.
                          </p>
                        )}
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          disabled={locked}
                          onClick={() => {
                            setSelectedId(row.id);
                            setReplacementConfirmed(false);
                          }}
                        >
                          Preview template
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No published templates found"
                    description="You can write the procedure plan below without a template."
                  />
                )}
                <Pagination
                  {...list.data}
                  label="Procedure template pagination"
                  disabled={locked}
                  onPageChange={(value) => {
                    setPage(value);
                    setSelectedId('');
                  }}
                />
              </>
            )
          )}
          {selectedId &&
            (preview.loading ? (
              <Loading />
            ) : preview.error ? (
              <ErrorState message={preview.error} retry={preview.reload} />
            ) : (
              preview.data && (
                <div className="procedure-template-preview">
                  <TemplateContent source={preview.data} />
                  <p>
                    Applying copies the published explanation and estimate. Your patient-specific
                    indication and appointment stay as entered.
                  </p>
                  {procedureFieldNames.some((key) => !!draft[key].trim()) && (
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={replacementConfirmed}
                        disabled={locked}
                        onChange={(event) => setReplacementConfirmed(event.target.checked)}
                      />
                      I understand applying this template replaces the explanation and estimate in
                      my current draft.
                    </label>
                  )}
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={
                      locked ||
                      !preview.data.template.active ||
                      !preview.data.publishedVersion ||
                      (procedureFieldNames.some((key) => !!draft[key].trim()) &&
                        !replacementConfirmed)
                    }
                    onClick={chooseTemplate}
                  >
                    Apply template
                  </button>
                </div>
              )
            ))}
        </section>
      )}
      <form className="procedure-plan-form" onSubmit={save}>
        {source && (
          <div className="procedure-template-source">
            <strong>
              Applied template: {source.publishedVersion!.fields.title} · Version{' '}
              {source.publishedVersion!.version}
            </strong>
            <p>
              The fields below belong to this patient’s plan. Later catalogue changes will not
              update a saved plan.
            </p>
            <button
              type="button"
              className="button button-ghost button-small"
              disabled={phase === 'saving' || phase === 'uncertain' || refreshing}
              onClick={detach}
            >
              Continue without template
            </button>
          </div>
        )}
        <Field label="Procedure name">
          <input
            value={draft.title}
            required
            maxLength={300}
            disabled={locked}
            onChange={(event) => edit('title', event.target.value)}
          />
        </Field>
        <Field label="Linked appointment">
          <select
            value={draft.appointmentId}
            disabled={locked}
            onChange={(event) => edit('appointmentId', event.target.value)}
          >
            <option value="">No linked appointment</option>
            {locked && attempt?.body.appointmentId && (
              <option value={attempt.body.appointmentId}>{attempt.appointmentLabel}</option>
            )}
            {appointments
              .filter(
                (a) =>
                  !['cancelled', 'no-show'].includes(a.status) &&
                  !(locked && a.id === attempt?.body.appointmentId),
              )
              .map((a) => (
                <option value={a.id} key={a.id}>
                  {appointmentLabel(a)}
                </option>
              ))}
          </select>
        </Field>
        <Field
          label="Indication / reason"
          hint="Always enter the reason for this patient; templates do not supply it."
        >
          <textarea
            value={draft.indication}
            required
            rows={3}
            maxLength={8000}
            disabled={locked}
            onChange={(event) => edit('indication', event.target.value)}
          />
        </Field>
        {procedureFieldNames
          .filter((key) => key !== 'title' && key !== 'estimatedCost')
          .map((key) => (
            <Field key={key} label={procedureFieldLabels[key]}>
              <textarea
                value={draft[key]}
                required
                rows={3}
                maxLength={8000}
                disabled={locked}
                onChange={(event) => edit(key, event.target.value)}
              />
            </Field>
          ))}
        <Field
          label="Estimated cost"
          hint="Optional descriptive estimate; this does not create a charge."
        >
          <input
            value={draft.estimatedCost}
            maxLength={300}
            disabled={locked}
            onChange={(event) => edit('estimatedCost', event.target.value)}
          />
        </Field>
        {source && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={patientReviewed}
              disabled={locked}
              onChange={(event) => setPatientReviewed(event.target.checked)}
            />
            I reviewed and tailored this plan for this patient.
          </label>
        )}
        <div className="notice">
          This saves an immutable plan for discussion. Record the patient’s decision separately
          before documenting completion. It does not reserve a procedure room or create an invoice.
        </div>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        {phase === 'conflict' && (
          <div className="procedure-template-refresh">
            <p>
              Your final fields are retained. Refresh the source and explicitly review the current
              publication before saving.
            </p>
            <button
              className="button button-secondary"
              type="button"
              disabled={refreshing}
              onClick={() => void refreshSource()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh template source'}
            </button>
            {refreshed && (
              <>
                <TemplateContent source={refreshed} />
                {refreshed.template.active && refreshed.publishedVersion ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={acceptRefreshed}
                  >
                    I reviewed the latest template; keep my patient-specific draft
                  </button>
                ) : (
                  <p>
                    This source is unavailable for new plans. Choose another template or continue
                    without template while retaining your fields.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {phase === 'uncertain' && (
          <p className="muted small">
            Resume this plan from the patient's chart in this signed-in tab. After a reload or
            sign-out, check All records before starting a new plan.
          </p>
        )}
        <div className="procedure-plan-actions">
          <button className="button button-secondary" type="button" onClick={close}>
            {phase === 'uncertain' || phase === 'saving' ? 'Close for now' : 'Cancel'}
          </button>
          <button
            className="button button-primary"
            disabled={
              phase === 'saving' ||
              phase === 'conflict' ||
              refreshing ||
              (phase === 'editing' && !!source && !patientReviewed)
            }
          >
            {phase === 'saving'
              ? 'Saving…'
              : phase === 'uncertain'
                ? 'Retry same request'
                : 'Save procedure plan'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

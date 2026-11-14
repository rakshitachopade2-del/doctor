import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import type { Appointment } from '../../shared/types';
import type { ProcedureTemplateDetail } from '../../shared/procedure-catalogue';
import { api, ApiError, formatDate, useSession, useToast } from '../lib';
import { EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import { useVisitData } from './visit-duration-helpers';
import { checkedTemplateDetail, checkedTemplatePage } from './procedure-catalogue-helpers';
import {
  checkedProcedureCreation,
  procedureFailure,
  procedureFieldLabels,
  procedureFieldNames,
  templateSelection,
  type ProcedurePlanAttempt,
  type ProcedurePlanBody,
  type ProcedurePlanDraft,
} from './procedure-plan-helpers';
import './procedure-plan.css';

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
export function ProcedurePlanModal({
  patientId,
  appointments,
  onClose,
  onSaved,
}: {
  patientId: string;
  appointments: Appointment[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { session } = useSession(),
    toast = useToast(),
    location = useLocation();
  const [draft, setDraft] = useState<ProcedurePlanDraft>(emptyDraft);
  const [picker, setPicker] = useState(false),
    [search, setSearch] = useState('');
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [selectedId, setSelectedId] = useState('');
  const [source, setSource] = useState<ProcedureTemplateDetail | null>(null);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false),
    [patientReviewed, setPatientReviewed] = useState(false);
  const [phase, setPhase] = useState<'editing' | 'saving' | 'uncertain' | 'conflict'>('editing');
  const [attempt, setAttempt] = useState<ProcedurePlanAttempt | null>(null),
    [error, setError] = useState('');
  const [refreshed, setRefreshed] = useState<ProcedureTemplateDetail | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const alive = useRef(false),
    pending = useRef(false),
    refreshId = useRef(0);
  const filters = { search: query, active: 'true' as const, publication: 'published' as const };
  const list = useVisitData(
    picker
      ? `/api/procedure-catalogue?${new URLSearchParams({ ...filters, page: String(page), pageSize: '10' })}`
      : null,
    (value) => checkedTemplatePage(value, filters, page, 10),
  );
  const preview = useVisitData(
    picker && selectedId ? `/api/procedure-catalogue/${encodeURIComponent(selectedId)}` : null,
    (value) => checkedTemplateDetail(value, selectedId),
  );
  const locked = phase !== 'editing' || refreshing;
  const canClose = phase !== 'saving' && phase !== 'uncertain';
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      refreshId.current++;
    };
  }, [location.key]);
  const current = () => alive.current && (window.history.state?.key ?? 'default') === location.key;
  function close() {
    if (!pending.current && canClose) onClose();
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
    setRefreshing(true);
    setRefreshed(null);
    setError('');
    try {
      const value = checkedTemplateDetail(
        await api(`/api/procedure-catalogue/${encodeURIComponent(source.template.id)}`),
        source.template.id,
      );
      if (current() && request === refreshId.current) setRefreshed(value);
    } catch (problem) {
      if (current() && request === refreshId.current) setError(procedureFailure(problem));
    } finally {
      if (current() && request === refreshId.current) setRefreshing(false);
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
    if (pending.current || refreshing || phase === 'conflict' || !session.user?.doctorId) return;
    if (!attempt && source && !patientReviewed) return;
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
      ...(source
        ? { templateSelection: templateSelection(source), reviewedForPatient: true as const }
        : {}),
    };
    const sent = attempt ?? {
      body,
      source,
      actorId: session.user.id,
      doctorId: session.user.doctorId,
    };
    const previouslyUncertain = phase === 'uncertain';
    pending.current = true;
    setAttempt(sent);
    setPhase('saving');
    setError('');
    try {
      checkedProcedureCreation(
        await api('/api/procedures', { method: 'POST', body: sent.body }),
        sent,
      );
      if (!current()) return;
      toast('Procedure plan saved.');
      await onSaved();
    } catch (problem) {
      if (!current()) return;
      const message = procedureFailure(problem);
      const collision =
        problem instanceof ApiError &&
        problem.status === 409 &&
        /request.*(used|different)|different.*request/i.test(message);
      if (
        previouslyUncertain ||
        collision ||
        !(problem instanceof ApiError) ||
        problem.status >= 500
      ) {
        setPhase('uncertain');
        setError(`The save outcome could not be confirmed. ${message}`);
      } else {
        setAttempt(null);
        setPatientReviewed(false);
        setRefreshed(null);
        setPhase(problem.status === 409 && sent.source ? 'conflict' : 'editing');
        setError(message);
      }
    } finally {
      pending.current = false;
    }
  }
  return (
    <Modal title="Plan a procedure" onClose={close}>
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
            {appointments
              .filter((a) => !['cancelled', 'no-show'].includes(a.status))
              .map((a) => (
                <option value={a.id} key={a.id}>
                  {formatDate(a.date)} · {a.time} IST · {a.durationMinutes ?? 30} minutes ·{' '}
                  {a.doctorName} · {a.reason}
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
            Keep this page open. The exact request is retained here until its outcome is confirmed;
            leaving the page discards this pending draft.
          </p>
        )}
        <div className="procedure-plan-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={!canClose}
            onClick={close}
          >
            Cancel
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

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { FileClock, Settings2, ShieldCheck, Stethoscope, Users } from 'lucide-react';
import type {
  ClinicConfigurationChange,
  ClinicConfigurationContext,
  ClinicConfigurationScope,
  ClinicModules,
  ClinicProfile,
} from '../../shared/clinic-configuration';
import { api, ApiError, useSession, useToast } from '../lib';
import { Badge, Card, ErrorState, Field, Loading } from './ui';
import { Pagination } from './Pagination';
import {
  checkedConfigurationContext,
  checkedConfigurationHistory,
  checkedConfigurationMutation,
  configurationError,
  configurationStamp,
  normalizedProfile,
  sameConfiguration,
  scopeChange,
  scopeRevision,
  scopeValue,
  useConfigurationData,
  type ConfigurationAttempt,
} from './clinic-configuration-helpers';
import './clinic-configuration.css';

const moduleOptions = [
  {
    key: 'intake',
    title: 'Structured intake',
    text: 'Give patients space to share their history before a consultation.',
    icon: FileClock,
  },
  {
    key: 'images',
    title: 'Clinical image library',
    text: 'Keep private clinical photographs and image reports connected to each patient.',
    icon: Stethoscope,
  },
  {
    key: 'followUp',
    title: 'Follow-up companion',
    text: 'Capture daily check-ins and keep clinic conversations connected to care.',
    icon: Users,
  },
] as const;
const profileLabels: Record<keyof ClinicProfile, string> = {
  name: 'Clinic name',
  tagline: 'Tagline',
  phone: 'Contact phone',
  email: 'Contact email',
  address: 'Clinic address',
  hours: 'Opening hours',
  timezone: 'Clinic time zone',
};

function ConfigurationValues({
  scope,
  value,
}: {
  scope: ClinicConfigurationScope;
  value: ClinicProfile | ClinicModules;
}) {
  return (
    <dl className="configuration-values">
      {scope === 'profile'
        ? Object.entries(profileLabels).map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{(value as ClinicProfile)[key as keyof ClinicProfile] || 'Not provided'}</dd>
            </div>
          ))
        : moduleOptions.map((item) => (
            <div key={item.key}>
              <dt>{item.title}</dt>
              <dd>{(value as ClinicModules)[item.key] ? 'Enabled' : 'Paused'}</dd>
            </div>
          ))}
    </dl>
  );
}
function Attribution({ change }: { change: ClinicConfigurationChange | null }) {
  return change ? (
    <p className="muted small">
      Last changed by {change.createdByName} · {configurationStamp(change.createdAt)} IST
      {change.source === 'legacy' ? ' · Earlier settings update' : ''}
    </p>
  ) : (
    <p className="muted small">
      Existing configuration. No attributed change has been recorded for this group.
    </p>
  );
}

/** A tab change invalidates in-flight effects without discarding either editor's draft. */
function useConfigurationGuard(onNavigation: () => void) {
  const location = useLocation();
  const mounted = useRef(false),
    generation = useRef(0),
    key = useRef(location.key),
    navigation = useRef(onNavigation);
  key.current = location.key;
  navigation.current = onNavigation;
  useLayoutEffect(() => {
    mounted.current = true;
    generation.current++;
    navigation.current();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [location.key]);
  return () => {
    const serial = generation.current,
      origin = key.current,
      href = window.location.href,
      nativeKey = window.history.state?.key;
    return () =>
      mounted.current &&
      generation.current === serial &&
      key.current === origin &&
      window.location.href === href &&
      window.history.state?.key === nativeKey;
  };
}

function ConfigurationEditor({
  initial,
  scope,
  onSaved,
}: {
  initial: ClinicConfigurationContext;
  scope: ClinicConfigurationScope;
  onSaved: () => void;
}) {
  const { session } = useSession();
  const toast = useToast();
  const [source, setSource] = useState(initial),
    [value, setValue] = useState(() => scopeValue(initial, scope));
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing');
  const [attempt, setAttempt] = useState<ConfigurationAttempt | null>(null),
    [reviewed, setReviewed] = useState<ClinicConfigurationContext | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const guard = useConfigurationGuard(() => setBusy(false));
  const locked = busy || phase !== 'editing';
  let normalized: ClinicProfile | ClinicModules | null = null;
  try {
    normalized = scope === 'profile' ? normalizedProfile(value as ClinicProfile) : value;
  } catch {
    /* Native form constraints explain incomplete input. */
  }
  const changed = normalized ? !sameConfiguration(normalized, scopeValue(source, scope)) : true;
  function update(next: ClinicProfile | ClinicModules) {
    setValue(next);
    setConfirmed(false);
    setError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || phase === 'conflict' || !session?.user) return;
    const uncertain = phase === 'uncertain';
    if (!uncertain && (!confirmed || !reason.trim() || !changed)) return;
    let sent = attempt;
    try {
      if (!sent) {
        const common = {
          reason: reason.trim(),
          expectedRevision: scopeRevision(source, scope),
          requestId: crypto.randomUUID(),
        };
        sent = {
          scope,
          actorId: session.user.id,
          source,
          body:
            scope === 'profile'
              ? { ...common, profile: normalizedProfile(value as ClinicProfile) }
              : { ...common, modules: value as ClinicModules },
        };
      }
    } catch (cause) {
      setError(configurationError(cause));
      return;
    }
    const current = guard();
    setAttempt(sent);
    setPhase('uncertain');
    setBusy(true);
    setError('');
    try {
      const raw = await api<unknown>(`/api/clinic-configuration/${scope}`, {
        method: 'POST',
        body: sent.body,
        isCurrent: current,
      });
      if (!current()) return;
      const result = checkedConfigurationMutation(raw, sent);
      setSource(result.context);
      setValue(scopeValue(result.context, scope));
      setReason('');
      setConfirmed(false);
      setReviewed(null);
      setAttempt(null);
      setPhase('editing');
      onSaved();
      toast(scope === 'profile' ? 'Clinic details saved.' : 'Care modules saved.');
    } catch (cause) {
      if (!current()) return;
      setError(configurationError(cause));
      if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        !/request|uuid|reus/i.test(cause.message)
      ) {
        setPhase('conflict');
        setAttempt(null);
        setConfirmed(false);
        setReviewed(null);
      } else if (
        !uncertain &&
        cause instanceof ApiError &&
        [400, 403, 404, 413, 422, 429].includes(cause.status)
      ) {
        setPhase('editing');
        setAttempt(null);
        setConfirmed(false);
      }
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function refresh() {
    if (busy) return;
    const current = guard();
    setBusy(true);
    setError('');
    setReviewed(null);
    try {
      const response = await api<unknown>('/api/clinic-configuration', { isCurrent: current });
      if (current()) setReviewed(checkedConfigurationContext(response));
    } catch (cause) {
      if (current()) setError(configurationError(cause));
    } finally {
      if (current()) setBusy(false);
    }
  }
  function accept() {
    if (!reviewed || busy) return;
    setSource(reviewed);
    setReviewed(null);
    setConfirmed(false);
    setAttempt(null);
    setPhase('editing');
    setError('');
  }
  return (
    <form
      className={`configuration-editor clinic-${scope}-form stack`}
      onSubmit={save}
      aria-label={scope === 'profile' ? 'Clinic profile changes' : 'Care module changes'}
    >
      <div>
        <h2>{scope === 'profile' ? 'Public clinic information' : 'Care module availability'}</h2>
        <p className="muted">
          {scope === 'profile'
            ? 'These details appear on patient-facing clinic pages. Your change reason and history are private to administrators.'
            : 'Turning off a module pauses new activity. Existing records remain available for continuity of care. Change reasons and history are private to administrators.'}
        </p>
        <Attribution change={scopeChange(source, scope)} />
      </div>
      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}
      {phase === 'uncertain' && !busy && (
        <div className="notice configuration-notice">
          The save outcome could not be confirmed. Your exact submitted request is retained. Retry
          the same request to confirm the result.
        </div>
      )}
      {phase === 'conflict' && (
        <section className="configuration-conflict stack" aria-label="Review latest configuration">
          <div className="notice configuration-notice">
            This group changed after your draft was opened. Your entries are retained. Refresh and
            review the latest saved values before continuing.
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? 'Refreshing…' : 'Refresh latest configuration'}
          </button>
          {reviewed && (
            <div className="configuration-latest stack">
              <h3>Latest saved {scope === 'profile' ? 'clinic profile' : 'care modules'}</h3>
              <ConfigurationValues scope={scope} value={scopeValue(reviewed, scope)} />
              <Attribution change={scopeChange(reviewed, scope)} />
              {scopeChange(reviewed, scope)?.reason && (
                <p>
                  Change reason: <span>{scopeChange(reviewed, scope)?.reason}</span>
                </p>
              )}
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={accept}
              >
                I reviewed the latest configuration; keep my draft
              </button>
            </div>
          )}
        </section>
      )}
      <fieldset disabled={locked} className="configuration-fields">
        <legend className="sr-only">
          {scope === 'profile' ? 'Clinic profile draft' : 'Care module draft'}
        </legend>
        {scope === 'profile' ? (
          <div className="stack">
            {(['name', 'tagline'] as const).map((key) => (
              <Field key={key} label={profileLabels[key]}>
                <input
                  value={(value as ClinicProfile)[key]}
                  required={key === 'name'}
                  maxLength={300}
                  onChange={(event) =>
                    update({ ...(value as ClinicProfile), [key]: event.target.value })
                  }
                />
              </Field>
            ))}
            <div className="form-grid">
              {(['phone', 'email'] as const).map((key) => (
                <Field key={key} label={profileLabels[key]}>
                  <input
                    type={key === 'email' ? 'email' : 'tel'}
                    value={(value as ClinicProfile)[key]}
                    maxLength={key === 'email' ? 254 : 300}
                    onChange={(event) =>
                      update({ ...(value as ClinicProfile), [key]: event.target.value })
                    }
                  />
                </Field>
              ))}
            </div>
            <Field label="Clinic address">
              <textarea
                value={(value as ClinicProfile).address}
                maxLength={300}
                onChange={(event) =>
                  update({ ...(value as ClinicProfile), address: event.target.value })
                }
              />
            </Field>
            <Field
              label="Opening hours"
              hint="Public information only. Appointment availability is managed in Schedules & closures."
            >
              <input
                value={(value as ClinicProfile).hours}
                maxLength={300}
                onChange={(event) =>
                  update({ ...(value as ClinicProfile), hours: event.target.value })
                }
              />
            </Field>
            <Field label="Clinic time zone">
              <input value="Asia/Kolkata (IST)" readOnly />
            </Field>
          </div>
        ) : (
          <div className="module-grid">
            {moduleOptions.map((item) => (
              <Card key={item.key}>
                <span className="module-icon">
                  <item.icon size={24} />
                </span>
                <h3>{item.title}</h3>
                <p className="muted">{item.text}</p>
                <label className="toggle-row">
                  <span>{(value as ClinicModules)[item.key] ? 'Enabled' : 'Paused'}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Enable ${item.title}`}
                    checked={(value as ClinicModules)[item.key]}
                    onChange={(event) =>
                      update({ ...(value as ClinicModules), [item.key]: event.target.checked })
                    }
                  />
                </label>
              </Card>
            ))}
          </div>
        )}
        <Field
          label={scope === 'profile' ? 'Reason for profile change' : 'Reason for module change'}
          hint="Private administrator history; this reason is not shown to patients."
        >
          <textarea
            value={reason}
            required
            maxLength={1000}
            onChange={(event) => {
              setReason(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <label className="configuration-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            required
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            {scope === 'profile'
              ? 'I reviewed these public clinic details.'
              : 'I reviewed how these module choices affect new activity.'}
          </span>
        </label>
      </fieldset>
      <div className="configuration-actions">
        <button
          className="button button-primary"
          disabled={busy || phase === 'conflict' || (phase !== 'uncertain' && !changed)}
        >
          {busy
            ? 'Saving…'
            : phase === 'uncertain'
              ? 'Retry same request'
              : scope === 'profile'
                ? 'Save clinic details'
                : 'Save modules'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={locked}
          onClick={() => {
            setValue(scopeValue(source, scope));
            setReason('');
            setConfirmed(false);
            setError('');
          }}
        >
          Discard {scope === 'profile' ? 'profile' : 'module'} draft
        </button>
      </div>
      {!changed && phase === 'editing' && <p className="muted small">No changes to this group.</p>}
    </form>
  );
}

function ConfigurationHistory({ revision }: { revision: number }) {
  const [params, setParams] = useSearchParams();
  const rawScope = params.get('scope');
  const scope = rawScope === 'profile' || rawScope === 'modules' ? rawScope : 'all';
  const rawPage = params.get('page') || '1',
    page =
      /^\d+$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) && Number(rawPage) > 0
        ? Number(rawPage)
        : 1;
  const path = `/api/clinic-configuration/history?scope=${scope}&page=${page}&pageSize=25`;
  const resource = useConfigurationData(path, (value) =>
    checkedConfigurationHistory(value, scope, page),
  );
  const initialRevision = useRef(revision);
  useEffect(() => {
    if (initialRevision.current !== revision) {
      initialRevision.current = revision;
      void resource.reload();
    }
  }, [revision, resource.reload]);
  useEffect(() => {
    if (!resource.loading && !resource.error && resource.data && resource.data.page !== page) {
      const next = new URLSearchParams(params);
      if (resource.data.page === 1) next.delete('page');
      else next.set('page', String(resource.data.page));
      setParams(next, { replace: true });
    }
  }, [resource.data, resource.loading, resource.error, page, params, setParams]);
  function navigate(nextPage: number, nextScope = scope) {
    const next = new URLSearchParams(params);
    next.set('tab', 'history');
    next.set('scope', nextScope);
    if (nextPage === 1) next.delete('page');
    else next.set('page', String(nextPage));
    setParams(next);
  }
  return (
    <section className="configuration-history stack" aria-label="Configuration history">
      <div className="section-heading">
        <div>
          <h2>Configuration history</h2>
          <p className="muted">
            Private administrator record of saved changes. Existing settings without a recorded
            change have no invented author or date.
          </p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          disabled={resource.loading}
          onClick={() => void resource.reload()}
        >
          Refresh history
        </button>
      </div>
      <Field label="Configuration history scope">
        <select value={scope} onChange={(event) => navigate(1, event.target.value as typeof scope)}>
          <option value="all">All configuration</option>
          <option value="profile">Clinic profile</option>
          <option value="modules">Care modules</option>
        </select>
      </Field>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorState message={resource.error} retry={resource.reload} />
      ) : (
        resource.data && (
          <>
            {resource.data.items.length === 0 ? (
              <Card>
                <h3>No configuration changes recorded</h3>
                <p className="muted">Saved profile and module changes will appear here.</p>
              </Card>
            ) : (
              resource.data.items.map((change) => (
                <article key={change.id} className="configuration-change card">
                  <div className="section-heading">
                    <h3>
                      {change.scope === 'profile'
                        ? 'Clinic profile changed'
                        : 'Care modules changed'}
                    </h3>
                    <Badge tone={change.source === 'legacy' ? 'neutral' : 'green'}>
                      {change.source === 'legacy' ? 'Earlier settings update' : 'Reviewed change'}
                    </Badge>
                  </div>
                  <p className="muted">
                    {change.createdByName} · {configurationStamp(change.createdAt)} IST
                  </p>
                  <p className="configuration-reason">
                    {change.reason ||
                      'No change reason was recorded by the earlier settings workflow.'}
                  </p>
                  <details>
                    <summary>View before and after</summary>
                    <div className="configuration-comparison">
                      <section>
                        <h4>Before</h4>
                        <ConfigurationValues scope={change.scope} value={change.before} />
                      </section>
                      <section>
                        <h4>After</h4>
                        <ConfigurationValues scope={change.scope} value={change.after} />
                      </section>
                    </div>
                  </details>
                </article>
              ))
            )}
            <Pagination
              {...resource.data}
              label="Configuration history pagination"
              onPageChange={(next) => navigate(next)}
            />
          </>
        )
      )}
    </section>
  );
}

export function ClinicConfigurationPanel({ activeTab }: { activeTab: string }) {
  const resource = useConfigurationData('/api/clinic-configuration', checkedConfigurationContext);
  const [initial, setInitial] = useState<ClinicConfigurationContext | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (resource.data && !initial) setInitial(resource.data);
  }, [resource.data, initial]);
  const active = activeTab === 'clinic' || activeTab === 'modules';
  return (
    <div className="clinic-configuration">
      <div hidden={!active}>
        {!initial &&
          (resource.loading ? (
            <Loading />
          ) : resource.error ? (
            <ErrorState message={resource.error} retry={resource.reload} />
          ) : null)}
      </div>
      {initial && (
        <>
          <section
            hidden={activeTab !== 'clinic'}
            role="tabpanel"
            id="settings-panel-clinic"
            aria-labelledby="settings-tab-clinic"
          >
            <div className="settings-grid">
              <Card>
                <ConfigurationEditor
                  initial={initial}
                  scope="profile"
                  onSaved={() => setRevision((value) => value + 1)}
                />
              </Card>
              <Card className="settings-tip">
                <Settings2 size={25} />
                <h2>A familiar face for your clinic.</h2>
                <p>Your public profile helps patients find your clinic and contact your team.</p>
                <div className="notice">
                  <ShieldCheck size={18} />
                  <span>
                    Patient records stay inside the protected workspace. Care module changes are
                    saved separately.
                  </span>
                </div>
              </Card>
            </div>
          </section>
          <section
            hidden={activeTab !== 'modules'}
            role="tabpanel"
            id="settings-panel-modules"
            aria-labelledby="settings-tab-modules"
          >
            <Card>
              <ConfigurationEditor
                initial={initial}
                scope="modules"
                onSaved={() => setRevision((value) => value + 1)}
              />
            </Card>
          </section>
        </>
      )}
      {activeTab === 'history' && (
        <section role="tabpanel" id="settings-panel-history" aria-labelledby="settings-tab-history">
          <ConfigurationHistory revision={revision} />
        </section>
      )}
    </div>
  );
}

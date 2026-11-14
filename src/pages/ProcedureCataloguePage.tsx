import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArrowLeft,
  BookOpen,
  History,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type {
  ProcedureTemplateDetail,
  ProcedureTemplateEvent,
  ProcedureTemplateFields,
  ProcedureTemplateVersion,
} from '../../shared/procedure-catalogue';
import { api, ApiError, useSession, useToast } from '../lib';
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
import { Pagination } from '../components/Pagination';
import { useVisitData } from '../components/visit-duration-helpers';
import {
  catalogueFailure,
  catalogueStamp,
  checkedCatalogueMutation,
  checkedTemplateDetail,
  checkedTemplateHistoryPage,
  checkedTemplatePage,
  checkedTemplateVersions,
  templateFieldKeys,
  templateFieldLabels,
  templateFieldsEqual,
  type CatalogueAction,
  type CatalogueAttempt,
  type CatalogueFilters,
} from '../components/procedure-catalogue-helpers';
import './procedure-catalogue.css';

const positive = (value: string | null) =>
  value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : 1;
const emptyFields: ProcedureTemplateFields = {
  title: '',
  benefits: '',
  risks: '',
  alternatives: '',
  aftercare: '',
  estimatedCost: '',
};
const actionTitles: Record<CatalogueAction, string> = {
  create: 'Create a procedure template',
  version: 'Save a new template version',
  publish: 'Make this version available for plans',
  archive: 'Archive this template',
  reactivate: 'Reactivate this template',
};
const actionLabels: Record<CatalogueAction, string> = {
  create: 'Save template draft',
  version: 'Save new version',
  publish: 'Make available for plans',
  archive: 'Archive template',
  reactivate: 'Reactivate template',
};
const eventLabels: Record<ProcedureTemplateEvent['operation'], string> = {
  created: 'Template created',
  'version-added': 'New draft saved',
  published: 'Version made available for plans',
  archived: 'Template archived',
  reactivated: 'Template reactivated',
};

function TemplateContent({ fields }: { fields: ProcedureTemplateFields }) {
  return (
    <dl className="procedure-catalogue-fields">
      {templateFieldKeys.map((key) => (
        <div key={key}>
          <dt>{templateFieldLabels[key]}</dt>
          <dd>{fields[key] || 'Not recorded'}</dd>
        </div>
      ))}
    </dl>
  );
}
function VersionContent({
  version,
  published = false,
}: {
  version: ProcedureTemplateVersion;
  published?: boolean;
}) {
  return (
    <div className="procedure-catalogue-version">
      <div className="row between">
        <h3>Version {version.version}</h3>
        <Badge tone={published ? 'green' : 'neutral'}>
          {published ? 'Current publication' : 'Saved version'}
        </Badge>
      </div>
      <p className="muted small">
        Written by {version.doctorName} · {catalogueStamp(version.createdAt)} IST
      </p>
      <TemplateContent fields={version.fields} />
      <div className="procedure-catalogue-private">
        <strong>Reason for this version</strong>
        <p>{version.reason}</p>
      </div>
    </div>
  );
}
function TemplateSource({ value }: { value: ProcedureTemplateDetail }) {
  return (
    <div className="procedure-catalogue-source">
      <strong>{value.template.title}</strong>
      <p>
        Latest version {value.latestVersion.version} ·{' '}
        {value.template.active ? 'Active' : 'Archived'} ·{' '}
        {value.publishedVersion
          ? `Published version ${value.publishedVersion.version}`
          : 'No published version'}
      </p>
      <p className="muted small">
        Latest change: {eventLabels[value.history[0].operation]} · {value.history[0].createdByName}{' '}
        · {catalogueStamp(value.history[0].createdAt)} IST
      </p>
      <p className="small">{value.history[0].reason}</p>
    </div>
  );
}

export function ProcedureCataloguePage() {
  const { session } = useSession(),
    toast = useToast(),
    location = useLocation();
  const [params, setParams] = useSearchParams();
  const search = (params.get('search') ?? '').trim().slice(0, 300);
  const active: CatalogueFilters['active'] = ['true', 'false', 'all'].includes(
    params.get('active') ?? '',
  )
    ? (params.get('active') as CatalogueFilters['active'])
    : 'true';
  const publication: CatalogueFilters['publication'] = ['all', 'published', 'unpublished'].includes(
    params.get('publication') ?? '',
  )
    ? (params.get('publication') as CatalogueFilters['publication'])
    : 'all';
  const page = positive(params.get('page')),
    templateId = params.get('template'),
    pageSize = 25;
  const filters = { search, active, publication },
    query = new URLSearchParams({ ...filters, page: String(page), pageSize: String(pageSize) });
  const catalogue = useVisitData(templateId ? null : `/api/procedure-catalogue?${query}`, (value) =>
    checkedTemplatePage(value, filters, page, pageSize),
  );
  const detail = useVisitData(
    templateId ? `/api/procedure-catalogue/${encodeURIComponent(templateId)}` : null,
    (value) => checkedTemplateDetail(value, templateId ?? undefined),
  );
  const [draft, setDraft] = useState(filters),
    [action, setAction] = useState<{
      kind: CatalogueAction;
      source: ProcedureTemplateDetail | null;
    } | null>(null);
  const ownNavigation = useRef<string | null>(null),
    currentLocation = useRef(location.key);
  currentLocation.current = location.key;
  useLayoutEffect(() => {
    if (ownNavigation.current === location.search) {
      ownNavigation.current = null;
      return;
    }
    ownNavigation.current = null;
    setDraft({ search, active, publication });
  }, [location.key, location.search, search, active, publication]);
  function navigate(values: Record<string, string | null>, replace = false, preserve = true) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    const target = next.size ? `?${next}` : '';
    ownNavigation.current = preserve && target !== location.search ? target : null;
    setParams(next, { replace });
  }
  useEffect(() => {
    if (catalogue.data && !catalogue.loading && !catalogue.error && catalogue.data.page !== page)
      navigate({ page: String(catalogue.data.page) }, true);
  }, [catalogue.data, page]);
  const canWrite =
      !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user?.role ?? ''),
    admin = session.user?.role === 'admin';
  async function saved(
    value: ProcedureTemplateDetail,
    key: string,
    historyKey: unknown,
    url: string,
  ) {
    if (
      currentLocation.current !== key ||
      (window.history.state?.key ?? null) !== historyKey ||
      window.location.href !== url
    )
      return;
    setAction(null);
    toast('Procedure catalogue updated.');
    if (templateId === value.template.id) await detail.reload();
    else navigate({ template: value.template.id, tab: null, versionPage: null, historyPage: null });
  }
  return (
    <div className="procedure-catalogue-page">
      <PageHeader
        eyebrow="CLINICIAN-AUTHORED INFORMATION"
        title={templateId ? 'Procedure template' : 'Procedure catalogue'}
        description="Reusable explanations, reviewed by a clinician. Every patient plan needs its own indication and review."
        actions={
          <>
            {templateId ? (
              <button
                className="button button-secondary"
                onClick={() =>
                  navigate({ template: null, tab: null, versionPage: null, historyPage: null })
                }
              >
                <ArrowLeft size={16} />
                Back to catalogue
              </button>
            ) : (
              canWrite && (
                <button
                  className="button button-primary"
                  onClick={() => setAction({ kind: 'create', source: null })}
                >
                  <Plus size={16} />
                  New template
                </button>
              )
            )}
            <button
              className="button button-secondary"
              disabled={templateId ? detail.loading : catalogue.loading}
              onClick={() => void (templateId ? detail.reload() : catalogue.reload())}
            >
              <RefreshCw size={16} />
              Refresh catalogue
            </button>
          </>
        }
      />
      {!canWrite && (
        <p className="notice">
          Clinical content and publication require an account linked to a clinician.{' '}
          {admin
            ? 'You can still archive or reactivate a template.'
            : 'You can read the catalogue and its history.'}
        </p>
      )}
      {templateId ? (
        detail.loading ? (
          <Loading />
        ) : detail.error ? (
          <ErrorState message={detail.error} retry={detail.reload} />
        ) : detail.data ? (
          <TemplateDetail
            value={detail.data}
            canWrite={canWrite}
            admin={admin}
            onAction={(kind) => setAction({ kind, source: detail.data })}
          />
        ) : null
      ) : (
        <>
          <Card>
            <form
              className="procedure-catalogue-filters"
              onSubmit={(event) => {
                event.preventDefault();
                navigate({
                  search: draft.search.trim(),
                  active: draft.active,
                  publication: draft.publication,
                  page: null,
                });
              }}
            >
              <Field label="Search procedure catalogue">
                <input
                  maxLength={300}
                  placeholder="Search latest or published title…"
                  value={draft.search}
                  onChange={(event) => setDraft({ ...draft, search: event.target.value })}
                />
              </Field>
              <Field label="Catalogue availability">
                <select
                  value={draft.active}
                  onChange={(event) =>
                    setDraft({ ...draft, active: event.target.value as CatalogueFilters['active'] })
                  }
                >
                  <option value="true">Active templates</option>
                  <option value="false">Archived templates</option>
                  <option value="all">All availability</option>
                </select>
              </Field>
              <Field label="Catalogue publication">
                <select
                  value={draft.publication}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      publication: event.target.value as CatalogueFilters['publication'],
                    })
                  }
                >
                  <option value="all">All publication states</option>
                  <option value="published">Published templates</option>
                  <option value="unpublished">Unpublished templates</option>
                </select>
              </Field>
              <div className="procedure-catalogue-filter-actions">
                <button className="button button-primary">
                  <Search size={16} />
                  Search catalogue
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => {
                    setDraft({ search: '', active: 'true', publication: 'all' });
                    navigate({ search: null, active: null, publication: null, page: null });
                  }}
                >
                  Reset filters
                </button>
              </div>
            </form>
          </Card>
          <div className="procedure-catalogue-list-heading">
            <h2>Templates</h2>
            <span className="muted small" role="status">
              {catalogue.loading
                ? 'Loading templates…'
                : catalogue.error
                  ? 'Template count unavailable'
                  : `${catalogue.data?.total ?? 0} templates in this view`}
            </span>
          </div>
          {catalogue.loading ? (
            <Loading />
          ) : catalogue.error ? (
            <ErrorState message={catalogue.error} retry={catalogue.reload} />
          ) : catalogue.data && !catalogue.data.items.length ? (
            <Card>
              <EmptyState
                title="No templates in this view"
                description="Adjust the filters, or create a clinician-authored draft. Templates become available for new plans only after an explicit publication review."
              />
            </Card>
          ) : catalogue.data ? (
            <div className="procedure-catalogue-list">
              {catalogue.data.items.map((item) => (
                <Card key={item.id} className="procedure-catalogue-row">
                  <div className="procedure-catalogue-row-title">
                    <span className="module-icon">
                      <BookOpen size={21} />
                    </span>
                    <div>
                      <h3>{item.title}</h3>
                      <p className="muted small">
                        Latest version {item.latestVersion} · Updated{' '}
                        {catalogueStamp(item.updatedAt)} IST
                      </p>
                      {item.publishedTitle && item.publishedTitle !== item.title && (
                        <p className="small">Published title: {item.publishedTitle}</p>
                      )}
                    </div>
                  </div>
                  <div className="procedure-catalogue-row-state">
                    <Badge
                      tone={!item.active ? 'neutral' : item.publishedVersion ? 'green' : 'amber'}
                    >
                      {!item.active
                        ? 'Archived'
                        : item.publishedVersion
                          ? 'Available for plans'
                          : 'Unpublished'}
                    </Badge>
                    {item.publishedVersion && item.publishedVersion < item.latestVersion ? (
                      <Badge tone="blue">Newer draft · v{item.latestVersion}</Badge>
                    ) : null}
                    <p className="muted small">
                      {item.publishedVersion
                        ? `Published version ${item.publishedVersion}`
                        : 'Clinical review needed before use'}
                    </p>
                  </div>
                  <button
                    className="button button-secondary button-small"
                    aria-label={`Open template ${item.title}`}
                    onClick={() =>
                      navigate({
                        template: item.id,
                        tab: null,
                        versionPage: null,
                        historyPage: null,
                      })
                    }
                  >
                    Open template
                  </button>
                </Card>
              ))}
            </div>
          ) : null}
          {catalogue.data && !catalogue.loading && !catalogue.error && (
            <Pagination
              {...catalogue.data}
              label="Procedure catalogue pagination"
              onPageChange={(next) => navigate({ page: String(next) })}
            />
          )}
          <p className="muted small">
            Pages show the current catalogue. Draft-only changes keep the existing published version
            available. No medical content is supplied automatically.
          </p>
        </>
      )}
      {action && (
        <CatalogueEditor
          key={`${action.kind}:${action.source?.template.id ?? 'new'}`}
          kind={action.kind}
          initial={action.source}
          onClose={() => setAction(null)}
          onSaved={(value, key, historyKey, url) => saved(value, key, historyKey, url)}
        />
      )}
    </div>
  );
}

function TemplateDetail({
  value,
  canWrite,
  admin,
  onAction,
}: {
  value: ProcedureTemplateDetail;
  canWrite: boolean;
  admin: boolean;
  onAction: (kind: CatalogueAction) => void;
}) {
  const [params, setParams] = useSearchParams();
  const tab = ['versions', 'history'].includes(params.get('tab') ?? '')
    ? params.get('tab')!
    : 'current';
  const versionPage = positive(params.get('versionPage')),
    historyPage = positive(params.get('historyPage')),
    pageSize = 10;
  const versions = useVisitData(
    tab === 'versions'
      ? `/api/procedure-catalogue/${encodeURIComponent(value.template.id)}/versions?page=${versionPage}&pageSize=${pageSize}`
      : null,
    (response) => checkedTemplateVersions(response, value.template.id, versionPage, pageSize),
  );
  const history = useVisitData(
    tab === 'history'
      ? `/api/procedure-catalogue/${encodeURIComponent(value.template.id)}/history?page=${historyPage}&pageSize=${pageSize}`
      : null,
    (response) => checkedTemplateHistoryPage(response, value.template.id, historyPage, pageSize),
  );
  function change(key: string, value: string, replace = false) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set(key, value);
        return next;
      },
      { replace },
    );
  }
  useEffect(() => {
    if (versions.data && versions.data.page !== versionPage)
      change('versionPage', String(versions.data.page), true);
  }, [versions.data, versionPage]);
  useEffect(() => {
    if (history.data && history.data.page !== historyPage)
      change('historyPage', String(history.data.page), true);
  }, [history.data, historyPage]);
  const newer = value.publishedVersion?.id !== value.latestVersion.id;
  return (
    <>
      <Card className="procedure-catalogue-summary">
        <TemplateSource value={value} />
        <div className="procedure-catalogue-actions">
          {canWrite && (
            <button className="button button-secondary" onClick={() => onAction('version')}>
              <Plus size={16} />
              New version
            </button>
          )}
          {canWrite && (
            <button
              className="button button-primary"
              disabled={!value.template.active || !newer}
              onClick={() => onAction('publish')}
            >
              <ShieldCheck size={16} />
              Make available for plans
            </button>
          )}
          {admin && (
            <button
              className="button button-secondary"
              onClick={() => onAction(value.template.active ? 'archive' : 'reactivate')}
            >
              <Archive size={16} />
              {value.template.active ? 'Archive template' : 'Reactivate template'}
            </button>
          )}
        </div>
      </Card>
      {!value.template.active && (
        <p className="notice">
          This template is archived and cannot be selected for new plans. Its versions, published
          content and existing patient plans are retained.
        </p>
      )}
      {value.template.active && value.publishedVersion && newer && (
        <p className="notice">
          Version {value.publishedVersion.version} remains available for new plans while version{' '}
          {value.latestVersion.version} awaits publication review.
        </p>
      )}
      <div className="procedure-catalogue-tabs" role="group" aria-label="Template views">
        {[
          ['current', 'Current content'],
          ['versions', 'Version history'],
          ['history', 'Activity history'],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`button ${tab === key ? 'button-primary' : 'button-secondary'}`}
            aria-pressed={tab === key}
            onClick={() => change('tab', key)}
          >
            {key === 'history' && <History size={15} />} {label}
          </button>
        ))}
      </div>
      {tab === 'current' ? (
        <div className="procedure-catalogue-current">
          <Card>
            <h2>{newer ? 'Latest draft' : 'Current published content'}</h2>
            {!newer && value.publication && (
              <p className="procedure-catalogue-review small">
                Made available by {value.publication.doctorName} ·{' '}
                {catalogueStamp(value.publication.createdAt)} IST
              </p>
            )}
            <VersionContent version={value.latestVersion} published={!newer} />
          </Card>
          {newer && value.publishedVersion && (
            <Card>
              <h2>Current published content</h2>
              <p className="muted small">
                Made available by {value.publication!.doctorName} ·{' '}
                {catalogueStamp(value.publication!.createdAt)} IST
              </p>
              <VersionContent version={value.publishedVersion} published />
            </Card>
          )}
        </div>
      ) : tab === 'versions' ? (
        versions.loading ? (
          <Loading />
        ) : versions.error ? (
          <ErrorState message={versions.error} retry={versions.reload} />
        ) : versions.data ? (
          <section
            className="procedure-catalogue-version-history"
            aria-label="Immutable template versions"
          >
            <p className="notice">
              Every saved version is retained. Catalogue reasons are visible only to clinical staff.
            </p>
            {versions.data.items.map((version) => (
              <Card key={version.id}>
                <details>
                  <summary>
                    Version {version.version} · {version.fields.title}
                  </summary>
                  <VersionContent
                    version={version}
                    published={version.id === value.publishedVersion?.id}
                  />
                </details>
              </Card>
            ))}
            <Pagination
              {...versions.data}
              label="Template version pagination"
              onPageChange={(page) => change('versionPage', String(page))}
            />
          </section>
        ) : null
      ) : history.loading ? (
        <Loading />
      ) : history.error ? (
        <ErrorState message={history.error} retry={history.reload} />
      ) : history.data ? (
        <section className="procedure-catalogue-history" aria-label="Template activity history">
          <p className="notice">
            These are internal catalogue changes. Existing patient plans retain the source and final
            content saved when they were created.
          </p>
          {history.data.items.map((event) => (
            <Card key={event.id}>
              <h3>{eventLabels[event.operation]}</h3>
              <p className="muted small">
                {event.createdByName} · {catalogueStamp(event.createdAt)} IST
              </p>
              <p>{event.reason}</p>
              <dl className="procedure-catalogue-event-state">
                <div>
                  <dt>Before</dt>
                  <dd>
                    {event.before
                      ? `${event.before.active ? 'Active' : 'Archived'} · ${event.before.publishedVersionId ? 'Publication retained' : 'Unpublished'}`
                      : 'No template'}
                  </dd>
                </div>
                <div>
                  <dt>After</dt>
                  <dd>
                    {event.after.active ? 'Active' : 'Archived'} ·{' '}
                    {event.after.publishedVersionId ? 'Publication retained' : 'Unpublished'}
                  </dd>
                </div>
              </dl>
            </Card>
          ))}
          <Pagination
            {...history.data}
            label="Template activity pagination"
            onPageChange={(page) => change('historyPage', String(page))}
          />
        </section>
      ) : null}
    </>
  );
}

function CatalogueEditor({
  kind,
  initial,
  onClose,
  onSaved,
}: {
  kind: CatalogueAction;
  initial: ProcedureTemplateDetail | null;
  onClose: () => void;
  onSaved: (
    value: ProcedureTemplateDetail,
    key: string,
    historyKey: unknown,
    url: string,
  ) => Promise<void>;
}) {
  const { session } = useSession(),
    location = useLocation();
  const [source, setSource] = useState(initial),
    [reviewed, setReviewed] = useState<ProcedureTemplateDetail | null>(null),
    [fields, setFields] = useState<ProcedureTemplateFields>(
      initial?.latestVersion.fields ?? emptyFields,
    ),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<CatalogueAttempt | null>(null),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(false),
    pending = useRef(false),
    key = useRef(location.key);
  key.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const content = kind === 'create' || kind === 'version',
    locked = busy || refreshing || phase !== 'editing';
  const normalized = Object.fromEntries(
    templateFieldKeys.map((field) => [field, fields[field].trim()]),
  ) as unknown as ProcedureTemplateFields;
  const applicable =
    kind === 'create' ||
    (!!source &&
      (kind === 'version' ||
        (kind === 'publish' &&
          source.template.active &&
          source.latestVersion.id !== source.publishedVersion?.id) ||
        (kind === 'archive' && source.template.active) ||
        (kind === 'reactivate' && !source.template.active)));
  const changed =
    kind !== 'version' || !source || !templateFieldsEqual(normalized, source.latestVersion.fields);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !applicable || !changed) return;
    const sourceId = source?.template.id;
    const sent: CatalogueAttempt = {
      kind,
      source,
      actorId: session.user!.id,
      actorRole: session.user!.role,
      doctorId: session.user!.doctorId ?? null,
      path:
        kind === 'create'
          ? '/api/procedure-catalogue'
          : `/api/procedure-catalogue/${encodeURIComponent(sourceId!)}/${kind === 'version' ? 'versions' : kind === 'publish' ? 'publish' : 'availability'}`,
      body: {
        requestId: crypto.randomUUID(),
        reason: reason.trim(),
        ...(content ? { fields: normalized } : {}),
        ...(source ? { expectedRevision: source.template.revision } : {}),
        ...(kind === 'publish'
          ? { versionId: source!.latestVersion.id, reviewed: true as const }
          : {}),
        ...(kind === 'archive' || kind === 'reactivate' ? { active: kind === 'reactivate' } : {}),
      },
    };
    setAttempt(sent);
    await save(sent);
  }
  async function save(sent: CatalogueAttempt) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const started = key.current,
      historyKey = window.history.state?.key ?? null,
      url = window.location.href,
      retryingUncertain = phase === 'uncertain';
    const current = () =>
      mounted.current &&
      key.current === started &&
      (window.history.state?.key ?? null) === historyKey &&
      window.location.href === url;
    try {
      const value = checkedCatalogueMutation(
        await api<unknown>(sent.path, { method: 'POST', body: sent.body, isCurrent: current }),
        sent,
      );
      if (!current()) return;
      await onSaved(value.detail, started, historyKey, url);
    } catch (cause) {
      if (!current()) return;
      setError(catalogueFailure(cause));
      if (retryingUncertain) {
        setPhase('uncertain');
      } else if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        !/request (?:id|identifier)|idempot|already used|different.*payload/i.test(cause.message) &&
        sent.source
      ) {
        setPhase('conflict');
        setReviewed(null);
        setConfirmed(false);
      } else if (cause instanceof ApiError && [400, 403, 404, 422, 429].includes(cause.status)) {
        setPhase('editing');
        setAttempt(null);
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  async function refresh() {
    if (!source || pending.current) return;
    pending.current = true;
    setRefreshing(true);
    setReviewed(null);
    const started = key.current,
      historyKey = window.history.state?.key ?? null,
      url = window.location.href;
    const current = () =>
      mounted.current &&
      key.current === started &&
      (window.history.state?.key ?? null) === historyKey &&
      window.location.href === url;
    try {
      const value = checkedTemplateDetail(
        await api<unknown>(`/api/procedure-catalogue/${encodeURIComponent(source.template.id)}`, {
          isCurrent: current,
        }),
        source.template.id,
      );
      if (current()) {
        setReviewed(value);
        setError('');
      }
    } catch (cause) {
      if (current()) setError(catalogueFailure(cause));
    } finally {
      pending.current = false;
      if (current()) setRefreshing(false);
    }
  }
  const reasonLabel = content
    ? 'Reason for this version'
    : kind === 'publish'
      ? 'Publication reason'
      : kind === 'archive'
        ? 'Archive reason'
        : 'Reactivation reason';
  return (
    <Modal
      title={actionTitles[kind]}
      onClose={() => {
        if (!pending.current && !busy && !refreshing && phase !== 'uncertain') onClose();
      }}
    >
      <form className="stack procedure-catalogue-editor" onSubmit={submit}>
        <p className="notice">
          Catalogue content and change reasons are private to clinical staff. Patient-specific
          indication and decisions are recorded in each patient’s plan.
        </p>
        {source && <TemplateSource value={source} />}
        {content ? (
          <fieldset disabled={locked} className="procedure-catalogue-fieldset">
            <legend className="sr-only">Template content</legend>
            {templateFieldKeys.map((field) => (
              <Field
                key={field}
                label={templateFieldLabels[field]}
                hint={
                  field === 'estimatedCost'
                    ? 'Optional descriptive estimate. This never creates invoice charges.'
                    : undefined
                }
              >
                {field === 'title' || field === 'estimatedCost' ? (
                  <input
                    required={field !== 'estimatedCost'}
                    maxLength={300}
                    value={fields[field]}
                    onChange={(event) => setFields({ ...fields, [field]: event.target.value })}
                  />
                ) : (
                  <textarea
                    required
                    rows={field === 'risks' ? 4 : 3}
                    maxLength={8000}
                    value={fields[field]}
                    onChange={(event) => setFields({ ...fields, [field]: event.target.value })}
                  />
                )}
              </Field>
            ))}
          </fieldset>
        ) : kind === 'publish' && source ? (
          <div className="procedure-catalogue-publish-preview">
            <h3>Review version {source.latestVersion.version}</h3>
            <TemplateContent fields={source.latestVersion.fields} />
          </div>
        ) : (
          <p>
            {kind === 'archive'
              ? 'Archiving prevents selection for new patient plans. All versions and existing patient plans remain available.'
              : 'Reactivation restores availability of the retained published version. It does not record a new clinical review.'}
          </p>
        )}
        <Field label={reasonLabel} hint="Required. Visible only to clinical staff.">
          <textarea
            required
            maxLength={1000}
            rows={3}
            disabled={locked}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {kind === 'publish' && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              disabled={locked}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>I reviewed this version for use in patient-specific procedure plans.</span>
          </label>
        )}
        {!applicable && (
          <p className="notice">
            This action is no longer available for the current template state. Close this form and
            review the latest record.
          </p>
        )}
        {!changed && (
          <p className="muted small">Change at least one content field to save a new version.</p>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {phase === 'uncertain' && (
          <div className="notice" role="status">
            <strong>The save outcome could not be confirmed.</strong>
            <p>
              Your exact submitted request is retained in this open form. Retry it to confirm the
              result without creating a second change.
            </p>
          </div>
        )}
        {phase === 'conflict' && (
          <div className="procedure-catalogue-conflict">
            <p className="notice">
              The template changed or the action is no longer eligible. Your draft is retained.
              Refresh and review the latest record before continuing.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={refreshing || busy}
              onClick={() => void refresh()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh latest template'}
            </button>
            {reviewed && (
              <>
                <TemplateSource value={reviewed} />
                {(content || kind === 'publish') && (
                  <details open>
                    <summary>
                      Latest saved content · version {reviewed.latestVersion.version}
                    </summary>
                    <TemplateContent fields={reviewed.latestVersion.fields} />
                  </details>
                )}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setSource(reviewed);
                    setReviewed(null);
                    setAttempt(null);
                    setPhase('editing');
                    setError('');
                    setConfirmed(false);
                  }}
                >
                  I reviewed the latest template; keep my draft
                </button>
              </>
            )}
          </div>
        )}
        <div className="procedure-catalogue-modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || refreshing || phase === 'uncertain'}
            onClick={onClose}
          >
            Cancel
          </button>
          {phase === 'uncertain' ? (
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !attempt}
              onClick={() => attempt && void save(attempt)}
            >
              {busy ? 'Saving…' : 'Retry same request'}
            </button>
          ) : (
            <button className="button button-primary" disabled={locked || !applicable || !changed}>
              {busy ? 'Saving…' : actionLabels[kind]}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

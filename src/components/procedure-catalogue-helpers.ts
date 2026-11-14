import type {
  ProcedureCataloguePage,
  ProcedureTemplateDetail,
  ProcedureTemplateEvent,
  ProcedureTemplateFields,
  ProcedureTemplateHistoryPage,
  ProcedureTemplateMutation,
  ProcedureTemplateRow,
  ProcedureTemplateState,
  ProcedureTemplateVersion,
  ProcedureTemplateVersionPage,
} from '../../shared/procedure-catalogue';
import type { Role } from '../../shared/types';

export type CatalogueFilters = ProcedureCataloguePage['filters'];
export const templateFieldKeys = [
  'title',
  'benefits',
  'risks',
  'alternatives',
  'aftercare',
  'estimatedCost',
] as const;
export const templateFieldLabels: Record<keyof ProcedureTemplateFields, string> = {
  title: 'Procedure name',
  benefits: 'Expected benefits',
  risks: 'Risks to discuss',
  alternatives: 'Alternatives to discuss',
  aftercare: 'Planned aftercare instructions',
  estimatedCost: 'Estimated cost',
};
export const catalogueFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be confirmed. Please try again.';
export const catalogueStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const bad = () =>
  new Error(
    'The catalogue response was incomplete or did not match this request. Refresh the record or retry the same submitted request.',
  );
export const templateFieldsEqual = (a: ProcedureTemplateFields, b: ProcedureTemplateFields) =>
  templateFieldKeys.every((key) => a[key] === b[key]);
export function checkedTemplateFields(value: unknown): ProcedureTemplateFields {
  if (
    !object(value) ||
    !templateFieldKeys.every(
      (key) =>
        typeof value[key] === 'string' &&
        (key === 'estimatedCost' || text(value[key])) &&
        String(value[key]).length <= (key === 'title' || key === 'estimatedCost' ? 300 : 8000),
    )
  )
    throw bad();
  return value as unknown as ProcedureTemplateFields;
}
export function checkedTemplateRow(value: unknown): ProcedureTemplateRow {
  if (
    !object(value) ||
    !text(value.id) ||
    !text(value.title) ||
    value.title.length > 300 ||
    typeof value.active !== 'boolean' ||
    !positive(value.latestVersion) ||
    !revision(value.revision) ||
    !revision(value.selectionRevision) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt)
  )
    throw bad();
  if (value.publishedVersion === null) {
    if (value.publishedTitle !== null || value.publishedAt !== null) throw bad();
  } else if (
    !positive(value.publishedVersion) ||
    value.publishedVersion > value.latestVersion ||
    !text(value.publishedTitle) ||
    value.publishedTitle.length > 300 ||
    !timestamp(value.publishedAt)
  )
    throw bad();
  return value as unknown as ProcedureTemplateRow;
}
export function checkedTemplateVersion(
  value: unknown,
  templateId: string,
): ProcedureTemplateVersion {
  if (
    !object(value) ||
    !text(value.id) ||
    value.templateId !== templateId ||
    !positive(value.version) ||
    !text(value.reason) ||
    value.reason.length > 1000 ||
    !['createdById', 'createdByName', 'doctorId', 'doctorName'].every((key) => text(value[key])) ||
    !timestamp(value.createdAt)
  )
    throw bad();
  checkedTemplateFields(value.fields);
  return value as unknown as ProcedureTemplateVersion;
}
const stateEqual = (a: ProcedureTemplateState, b: ProcedureTemplateState) =>
  a.active === b.active &&
  a.latestVersionId === b.latestVersionId &&
  a.publishedVersionId === b.publishedVersionId;
function checkedState(value: unknown): ProcedureTemplateState {
  if (
    !object(value) ||
    typeof value.active !== 'boolean' ||
    !text(value.latestVersionId) ||
    !(value.publishedVersionId === null || text(value.publishedVersionId))
  )
    throw bad();
  return value as unknown as ProcedureTemplateState;
}
export function checkedTemplateEvent(value: unknown, templateId: string): ProcedureTemplateEvent {
  if (
    !object(value) ||
    !text(value.id) ||
    value.templateId !== templateId ||
    !['created', 'version-added', 'published', 'archived', 'reactivated'].includes(
      value.operation as string,
    ) ||
    !uuid(value.requestId) ||
    !text(value.reason) ||
    value.reason.length > 1000 ||
    !text(value.createdById) ||
    !text(value.createdByName) ||
    !['doctor', 'admin'].includes(value.createdByRole as string) ||
    !timestamp(value.createdAt) ||
    !(
      (value.doctorId === null && value.doctorName === null) ||
      (text(value.doctorId) && text(value.doctorName))
    )
  )
    throw bad();
  const after = checkedState(value.after);
  if (value.operation === 'created') {
    if (
      value.before !== null ||
      value.expectedRevision !== null ||
      !after.active ||
      after.publishedVersionId !== null ||
      value.versionId !== after.latestVersionId ||
      !text(value.doctorId)
    )
      throw bad();
  } else {
    const before = checkedState(value.before);
    if (!revision(value.expectedRevision)) throw bad();
    if (value.operation === 'version-added') {
      if (
        !text(value.doctorId) ||
        value.versionId !== after.latestVersionId ||
        before.latestVersionId === after.latestVersionId ||
        before.active !== after.active ||
        before.publishedVersionId !== after.publishedVersionId
      )
        throw bad();
    } else if (value.operation === 'published') {
      if (
        !text(value.doctorId) ||
        !before.active ||
        !after.active ||
        before.latestVersionId !== after.latestVersionId ||
        value.versionId !== after.latestVersionId ||
        after.publishedVersionId !== value.versionId ||
        before.publishedVersionId === after.publishedVersionId
      )
        throw bad();
    } else if (
      value.createdByRole !== 'admin' ||
      value.versionId !== null ||
      before.active === after.active ||
      after.active !== (value.operation === 'reactivated') ||
      before.latestVersionId !== after.latestVersionId ||
      before.publishedVersionId !== after.publishedVersionId
    )
      throw bad();
  }
  return value as unknown as ProcedureTemplateEvent;
}
function checkedHistory(value: unknown, id: string): ProcedureTemplateEvent[] {
  if (!Array.isArray(value)) throw bad();
  const events = value.map((entry) => checkedTemplateEvent(entry, id));
  if (
    new Set(events.map((event) => event.id)).size !== events.length ||
    new Set(events.map((event) => event.requestId)).size !== events.length ||
    events.some(
      (event, index) =>
        index > 0 &&
        (!events[index - 1].before || !stateEqual(events[index - 1].before!, event.after)),
    )
  )
    throw bad();
  return events;
}
export function checkedTemplateDetail(value: unknown, id?: string): ProcedureTemplateDetail {
  if (!object(value)) throw bad();
  const template = checkedTemplateRow(value.template);
  if (id && template.id !== id) throw bad();
  const latestVersion = checkedTemplateVersion(value.latestVersion, template.id),
    publishedVersion =
      value.publishedVersion === null
        ? null
        : checkedTemplateVersion(value.publishedVersion, template.id);
  const history = checkedHistory(value.history, template.id);
  const publication =
    value.publication === null ? null : checkedTemplateEvent(value.publication, template.id);
  if (
    publishedVersion
      ? !publication ||
        publication.operation !== 'published' ||
        publication.versionId !== publishedVersion.id ||
        publication.createdAt !== template.publishedAt
      : publication !== null
  )
    throw bad();
  const publicationHistory = publication && history.find((event) => event.id === publication.id);
  if (publication && publicationHistory && !eventEqual(publication, publicationHistory))
    throw bad();
  if (
    latestVersion.version !== template.latestVersion ||
    latestVersion.fields.title !== template.title ||
    (publishedVersion?.version ?? null) !== template.publishedVersion ||
    (publishedVersion?.fields.title ?? null) !== template.publishedTitle ||
    (publishedVersion?.version === latestVersion.version &&
      publishedVersion.id !== latestVersion.id) ||
    !positive(value.historyTotal) ||
    history.length !== Math.min(25, value.historyTotal) ||
    !history.length ||
    !stateEqual(history[0].after, {
      active: template.active,
      latestVersionId: latestVersion.id,
      publishedVersionId: publishedVersion?.id ?? null,
    }) ||
    (publishedVersion?.id === latestVersion.id &&
      !templateFieldsEqual(publishedVersion.fields, latestVersion.fields))
  )
    throw bad();
  return {
    ...value,
    template,
    latestVersion,
    publishedVersion,
    publication,
    history,
  } as unknown as ProcedureTemplateDetail;
}
function checkedPagination(
  value: Record<string, unknown>,
  requestedPage: number,
  pageSize: number,
) {
  if (
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0 ||
    !positive(value.page) ||
    value.pageSize !== pageSize ||
    value.totalPages !== Math.max(1, Math.ceil(Number(value.total) / pageSize)) ||
    value.page !== Math.min(requestedPage, Number(value.totalPages)) ||
    !Array.isArray(value.items) ||
    value.items.length !==
      Math.min(pageSize, Math.max(0, Number(value.total) - (value.page - 1) * pageSize))
  )
    throw bad();
}
export function checkedTemplatePage(
  value: unknown,
  filters: CatalogueFilters,
  page: number,
  pageSize: number,
): ProcedureCataloguePage {
  if (
    !object(value) ||
    !object(value.filters) ||
    value.filters.search !== filters.search ||
    value.filters.active !== filters.active ||
    value.filters.publication !== filters.publication ||
    !Array.isArray(value.items)
  )
    throw bad();
  checkedPagination(value, page, pageSize);
  const items = value.items.map(checkedTemplateRow);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        (filters.active !== 'all' && item.active !== (filters.active === 'true')) ||
        (filters.publication === 'published' && item.publishedVersion === null) ||
        (filters.publication === 'unpublished' && item.publishedVersion !== null),
    )
  )
    throw bad();
  return { ...value, items } as unknown as ProcedureCataloguePage;
}
export function checkedTemplateVersions(
  value: unknown,
  id: string,
  page: number,
  pageSize: number,
): ProcedureTemplateVersionPage {
  if (!object(value) || value.templateId !== id || !Array.isArray(value.items)) throw bad();
  checkedPagination(value, page, pageSize);
  const items = value.items.map((entry) => checkedTemplateVersion(entry, id));
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item, index) =>
        item.version !== Number(value.total) - (Number(value.page) - 1) * pageSize - index,
    )
  )
    throw bad();
  return { ...value, items } as unknown as ProcedureTemplateVersionPage;
}
export function checkedTemplateHistoryPage(
  value: unknown,
  id: string,
  page: number,
  pageSize: number,
): ProcedureTemplateHistoryPage {
  if (!object(value) || value.templateId !== id) throw bad();
  checkedPagination(value, page, pageSize);
  return {
    ...value,
    items: checkedHistory(value.items, id),
  } as unknown as ProcedureTemplateHistoryPage;
}
export type CatalogueAction = 'create' | 'version' | 'publish' | 'archive' | 'reactivate';
export type CatalogueAttempt = {
  kind: CatalogueAction;
  source: ProcedureTemplateDetail | null;
  actorId: string;
  actorRole: Role;
  doctorId: string | null;
  path: string;
  body: {
    requestId: string;
    reason: string;
    fields?: ProcedureTemplateFields;
    expectedRevision?: string;
    versionId?: string;
    reviewed?: true;
    active?: boolean;
  };
};
const eventEqual = (a: ProcedureTemplateEvent, b: ProcedureTemplateEvent) =>
  [
    'id',
    'templateId',
    'operation',
    'versionId',
    'reason',
    'requestId',
    'expectedRevision',
    'createdById',
    'createdByName',
    'createdByRole',
    'doctorId',
    'doctorName',
    'createdAt',
  ].every(
    (key) => a[key as keyof ProcedureTemplateEvent] === b[key as keyof ProcedureTemplateEvent],
  ) &&
  (a.before === null ? b.before === null : b.before !== null && stateEqual(a.before, b.before)) &&
  stateEqual(a.after, b.after);
export function checkedCatalogueMutation(
  value: unknown,
  attempt: CatalogueAttempt,
): ProcedureTemplateMutation {
  if (!object(value)) throw bad();
  const detail = checkedTemplateDetail(value.detail, attempt.source?.template.id),
    event = checkedTemplateEvent(value.event, detail.template.id),
    source = attempt.source;
  const operation = {
    create: 'created',
    version: 'version-added',
    publish: 'published',
    archive: 'archived',
    reactivate: 'reactivated',
  }[attempt.kind];
  if (
    event.operation !== operation ||
    event.requestId !== attempt.body.requestId ||
    event.createdById !== attempt.actorId ||
    event.createdByRole !== attempt.actorRole ||
    event.reason !== attempt.body.reason ||
    event.expectedRevision !== (attempt.body.expectedRevision ?? null) ||
    event.doctorId !== attempt.doctorId ||
    (source &&
      (!event.before ||
        !stateEqual(event.before, {
          active: source.template.active,
          latestVersionId: source.latestVersion.id,
          publishedVersionId: source.publishedVersion?.id ?? null,
        }))) ||
    (source && source.history.some((previous) => previous.id === event.id)) ||
    (source && detail.template.revision === source.template.revision)
  )
    throw bad();
  const recorded = detail.history.find((entry) => entry.id === event.id);
  if (recorded ? !eventEqual(recorded, event) : detail.historyTotal <= 25) throw bad();
  if (attempt.kind === 'publish' && event.versionId !== attempt.body.versionId) throw bad();
  if (
    (attempt.kind === 'archive' || attempt.kind === 'reactivate') &&
    event.after.active !== attempt.body.active
  )
    throw bad();
  const version =
    value.version === null ? null : checkedTemplateVersion(value.version, detail.template.id);
  if (event.versionId === null ? version !== null : !version || version.id !== event.versionId)
    throw bad();
  if (
    attempt.body.fields &&
    (!version ||
      !templateFieldsEqual(version.fields, attempt.body.fields) ||
      version.createdById !== attempt.actorId ||
      version.doctorId !== attempt.doctorId ||
      version.reason !== attempt.body.reason ||
      version.version !== (source ? source.latestVersion.version + 1 : 1))
  )
    throw bad();
  if (
    attempt.kind === 'publish' &&
    (!version ||
      !source ||
      version.version !== source.latestVersion.version ||
      !templateFieldsEqual(version.fields, source.latestVersion.fields))
  )
    throw bad();
  const currentVersion =
    version &&
    [detail.latestVersion, detail.publishedVersion].find((entry) => entry?.id === version.id);
  if (
    version &&
    currentVersion &&
    (!templateFieldsEqual(version.fields, currentVersion.fields) ||
      version.version !== currentVersion.version ||
      version.createdById !== currentVersion.createdById ||
      version.doctorId !== currentVersion.doctorId ||
      version.createdAt !== currentVersion.createdAt ||
      version.reason !== currentVersion.reason)
  )
    throw bad();
  return { detail, event, version };
}

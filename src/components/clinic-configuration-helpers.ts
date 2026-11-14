import type {
  ClinicConfigurationChange,
  ClinicConfigurationContext,
  ClinicConfigurationHistory,
  ClinicConfigurationMutation,
  ClinicConfigurationScope,
  ClinicModules,
  ClinicModulesInput,
  ClinicProfile,
  ClinicProfileInput,
} from '../../shared/clinic-configuration';
export { useCancellationData as useConfigurationData } from './series-cancellation-helpers';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && !!value.trim();
const hash = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  text(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const stamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const bad = () =>
  new Error(
    'The clinic configuration response could not be confirmed. Refresh the view or retry the exact submitted request.',
  );
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw bad();
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const sameConfiguration = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const configurationError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The save outcome could not be confirmed. Please retry the same request.';
export const configurationStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
export function profileFrom(context: ClinicConfigurationContext): ClinicProfile {
  const { modules: _modules, ...profile } = context.settings;
  return profile;
}
export const scopeValue = (
  context: ClinicConfigurationContext,
  scope: ClinicConfigurationScope,
): ClinicProfile | ClinicModules =>
  scope === 'profile' ? profileFrom(context) : { ...context.settings.modules };
export const scopeRevision = (
  context: ClinicConfigurationContext,
  scope: ClinicConfigurationScope,
) => (scope === 'profile' ? context.profileRevision : context.modulesRevision);
export const scopeChange = (
  context: ClinicConfigurationContext,
  scope: ClinicConfigurationScope,
) => (scope === 'profile' ? context.latestProfileChange : context.latestModulesChange);
export function checkedProfile(value: unknown): ClinicProfile {
  requireValue(
    object(value) &&
      nonempty(value.name) &&
      value.name.length <= 300 &&
      ['tagline', 'phone', 'address', 'hours'].every(
        (key) => text(value[key]) && value[key].length <= 300,
      ) &&
      text(value.email) &&
      value.email.length <= 254 &&
      (!value.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) &&
      value.timezone === 'Asia/Kolkata',
  );
  return {
    name: value.name,
    tagline: String(value.tagline),
    phone: String(value.phone),
    email: value.email,
    address: String(value.address),
    hours: String(value.hours),
    timezone: value.timezone,
  };
}
export function checkedModules(value: unknown): ClinicModules {
  requireValue(
    object(value) &&
      ['intake', 'images', 'followUp'].every((key) => typeof value[key] === 'boolean'),
  );
  return {
    intake: value.intake as boolean,
    images: value.images as boolean,
    followUp: value.followUp as boolean,
  };
}
export function normalizedProfile(value: ClinicProfile): ClinicProfile {
  return checkedProfile({
    ...value,
    name: value.name.trim(),
    tagline: value.tagline.trim(),
    phone: value.phone.trim(),
    email: value.email.trim().toLowerCase(),
    address: value.address.trim(),
    hours: value.hours.trim(),
  });
}
export function checkedConfigurationChange(value: unknown): ClinicConfigurationChange {
  requireValue(
    object(value) &&
      uuid(value.id) &&
      ['profile', 'modules'].includes(value.scope as string) &&
      ['reviewed', 'legacy'].includes(value.source as string) &&
      nonempty(value.createdByName) &&
      stamp(value.createdAt),
  );
  requireValue(
    value.source === 'legacy'
      ? value.reason === null
      : nonempty(value.reason) &&
          value.reason === value.reason.trim() &&
          value.reason.length <= 1000,
  );
  if (value.scope === 'profile') {
    const before = checkedProfile(value.before),
      after = checkedProfile(value.after);
    requireValue(!sameConfiguration(before, after));
    return { ...value, before, after } as ClinicConfigurationChange;
  }
  const before = checkedModules(value.before),
    after = checkedModules(value.after);
  requireValue(!sameConfiguration(before, after));
  return { ...value, before, after } as ClinicConfigurationChange;
}
export function checkedConfigurationContext(value: unknown): ClinicConfigurationContext {
  requireValue(
    object(value) &&
      object(value.settings) &&
      hash(value.profileRevision) &&
      hash(value.modulesRevision),
  );
  const profile = checkedProfile(value.settings),
    modules = checkedModules(value.settings.modules);
  const latestProfileChange =
    value.latestProfileChange === null
      ? null
      : checkedConfigurationChange(value.latestProfileChange);
  const latestModulesChange =
    value.latestModulesChange === null
      ? null
      : checkedConfigurationChange(value.latestModulesChange);
  requireValue(
    !latestProfileChange ||
      (latestProfileChange.scope === 'profile' &&
        sameConfiguration(latestProfileChange.after, profile)),
  );
  requireValue(
    !latestModulesChange ||
      (latestModulesChange.scope === 'modules' &&
        sameConfiguration(latestModulesChange.after, modules)),
  );
  return {
    settings: { ...profile, modules },
    profileRevision: String(value.profileRevision),
    modulesRevision: String(value.modulesRevision),
    latestProfileChange: latestProfileChange as ClinicConfigurationContext['latestProfileChange'],
    latestModulesChange: latestModulesChange as ClinicConfigurationContext['latestModulesChange'],
  };
}
export interface ConfigurationAttempt {
  scope: ClinicConfigurationScope;
  actorId: string;
  source: ClinicConfigurationContext;
  body: ClinicProfileInput | ClinicModulesInput;
}
export function checkedConfigurationMutation(
  value: unknown,
  attempt: ConfigurationAttempt,
): ClinicConfigurationMutation {
  requireValue(object(value) && object(value.receipt));
  const context = checkedConfigurationContext(value.context),
    change = checkedConfigurationChange(value.change),
    receipt = value.receipt;
  const submitted = 'profile' in attempt.body ? attempt.body.profile : attempt.body.modules;
  requireValue(
    receipt.requestId === attempt.body.requestId &&
      receipt.actorId === attempt.actorId &&
      receipt.scope === attempt.scope &&
      receipt.expectedRevision === attempt.body.expectedRevision &&
      receipt.changeId === change.id &&
      change.scope === attempt.scope &&
      change.source === 'reviewed' &&
      change.reason === attempt.body.reason &&
      sameConfiguration(change.before, scopeValue(attempt.source, attempt.scope)) &&
      sameConfiguration(change.after, submitted) &&
      change.id !== scopeChange(attempt.source, attempt.scope)?.id &&
      scopeRevision(context, attempt.scope) !== scopeRevision(attempt.source, attempt.scope),
  );
  return { context, change, receipt: receipt as unknown as ClinicConfigurationMutation['receipt'] };
}
export function checkedConfigurationHistory(
  value: unknown,
  scope: 'all' | ClinicConfigurationScope,
  page: number,
): ClinicConfigurationHistory {
  requireValue(
    object(value) &&
      count(value.total) &&
      value.pageSize === 25 &&
      value.totalPages === Math.max(1, Math.ceil(Number(value.total) / 25)) &&
      value.page === Math.min(page, Number(value.totalPages)) &&
      Array.isArray(value.items),
  );
  const items = value.items.map(checkedConfigurationChange);
  requireValue(
    items.length ===
      Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25)) &&
      new Set(items.map((item) => item.id)).size === items.length &&
      items.every((item) => scope === 'all' || item.scope === scope),
  );
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}

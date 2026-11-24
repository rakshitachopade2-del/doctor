import { z } from 'zod';
import {
  doctorProfileFields,
  type DoctorProfileFields,
} from '../../shared/doctor-profile-creation';
import type {
  DoctorProfileEditCommand,
  DoctorProfileEditContext,
  DoctorProfileEditHistory,
} from '../../shared/doctor-profile-edit';
import { ApiError } from '../lib';
import { profileLabels } from './DoctorProfileForm';

export type ProfileKey = keyof DoctorProfileFields;
export const profileKeys = Object.keys(profileLabels) as ProfileKey[];
export type ProfileEditAttempt = {
  source: DoctorProfileEditContext;
  command: DoctorProfileEditCommand;
};
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const fields = doctorProfileFields
  .extend({ color: doctorProfileFields.shape.color.unwrap() })
  .strict();
const snapshot = fields.extend({ id: z.string().min(1) });
const context = z.strictObject({ doctor: snapshot, revision });
const receipt = z.strictObject({
  actorId: z.string(),
  doctorId: z.string(),
  requestId: z.string(),
  expectedRevision: revision,
  revision,
  before: snapshot,
  after: snapshot,
});
const refusal = z.strictObject({
  code: z.enum(['DOCTOR_PROFILE_CHANGED', 'DOCTOR_PROFILE_UNCHANGED']),
  actorId: z.string(),
  doctorId: z.string(),
  requestId: z.string(),
  expectedRevision: revision,
  profile: fields,
});
const historyItem = z.strictObject({
  id: z.string().min(1),
  doctorId: z.string(),
  actorId: z.string().min(1),
  actorName: z.string().min(1),
  createdAt: z.iso.datetime(),
  source: z.enum(['reviewed', 'legacy']),
  before: snapshot,
  after: snapshot,
});
const history = z.strictObject({
  items: z.array(historyItem).max(10),
  page: z.number().int().positive(),
  pageSize: z.literal(10),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
});

export function sameValue(first: unknown, second: unknown) {
  if (!Array.isArray(first)) return first === second;
  return (
    Array.isArray(second) &&
    first.length === second.length &&
    first.every((v, i) => v === second[i])
  );
}
export function differentFields(first: DoctorProfileFields, second: DoctorProfileFields) {
  return profileKeys.filter((key) => !sameValue(first[key], second[key]));
}
// Compare the actual JSON too. Input schemas trim text, while a receipt must echo the exact review.
function exactFields(raw: unknown, expected: DoctorProfileFields) {
  if (!raw || typeof raw !== 'object') return false;
  return profileKeys.every((key) =>
    sameValue((raw as Record<string, unknown>)[key], expected[key]),
  );
}
export function checkedProfileContext(raw: unknown, doctorId: string): DoctorProfileEditContext {
  const parsed = context.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.doctor.id !== doctorId ||
    !exactFields((raw as DoctorProfileEditContext).doctor, parsed.data.doctor)
  )
    throw new Error('The current doctor profile could not be confirmed.');
  return parsed.data;
}
export function checkedEditReceipt(raw: unknown, attempt: ProfileEditAttempt, actorId: string) {
  const parsed = z.strictObject({ receipt }).safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data.receipt;
  const { source, command } = attempt,
    doctorId = source.doctor.id;
  const original = (raw as typeof parsed.data).receipt;
  return r.actorId === actorId &&
    r.doctorId === doctorId &&
    r.before.id === doctorId &&
    r.after.id === doctorId &&
    r.requestId === command.requestId &&
    r.expectedRevision === command.expectedRevision &&
    r.revision !== r.expectedRevision &&
    exactFields(original.before, source.doctor) &&
    exactFields(original.after, command.profile)
    ? r
    : null;
}
export function checkedEditRefusal(error: unknown, attempt: ProfileEditAttempt, actorId: string) {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const result = refusal.safeParse(error.responseData);
  if (!result.success) return null;
  const r = result.data,
    { command, source } = attempt;
  return r.actorId === actorId &&
    r.doctorId === source.doctor.id &&
    r.requestId === command.requestId &&
    r.expectedRevision === command.expectedRevision &&
    exactFields((error.responseData as typeof r).profile, command.profile)
    ? r.code
    : null;
}
export function checkedProfileHistory(
  raw: unknown,
  doctorId: string,
  requested: number,
): DoctorProfileEditHistory {
  const parsed = history.safeParse(raw);
  if (parsed.success) {
    const h = parsed.data;
    if (
      h.totalPages === Math.max(1, Math.ceil(h.total / h.pageSize)) &&
      h.page === Math.min(requested, h.totalPages) &&
      h.items.length === Math.min(h.pageSize, h.total - (h.page - 1) * h.pageSize) &&
      new Set(h.items.map((item) => item.id)).size === h.items.length &&
      h.items.every(
        (item, i) =>
          item.doctorId === doctorId &&
          item.before.id === doctorId &&
          item.after.id === doctorId &&
          exactFields((raw as DoctorProfileEditHistory).items[i].before, item.before) &&
          exactFields((raw as DoctorProfileEditHistory).items[i].after, item.after),
      )
    )
      return h;
  }
  throw new Error('The doctor profile history could not be confirmed.');
}

export function rebaseProfile(attempt: ProfileEditAttempt, latest: DoctorProfileEditContext) {
  let draft = doctorProfileFields.parse(latest.doctor);
  const conflicts: ProfileKey[] = [];
  const before = attempt.source.doctor,
    mine = attempt.command.profile;
  for (const key of differentFields(before, mine)) {
    if (!sameValue(before[key], latest.doctor[key]) && !sameValue(mine[key], latest.doctor[key]))
      conflicts.push(key);
    else draft = { ...draft, [key]: mine[key] };
  }
  return { draft, conflicts };
}

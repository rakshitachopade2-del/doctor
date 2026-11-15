import type {
  DoctorBookingChange,
  DoctorBookingContext,
  DoctorBookingHistory,
  DoctorBookingInput,
  DoctorBookingMutation,
} from '../../shared/doctor-booking';
export {
  useCancellationData as useDoctorBookingData,
  useCancellationGuard as useDoctorBookingGuard,
} from './series-cancellation-helpers';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function check(condition: unknown): asserts condition {
  if (!condition)
    throw new Error(
      'The booking-status response could not be confirmed. Refresh the view or retry the same submitted request.',
    );
}
export const doctorBookingLabel = (accepting: boolean) =>
  accepting ? 'Accepting new bookings' : 'New bookings paused';
export const doctorBookingStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
export const doctorBookingFailure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The save outcome could not be confirmed. Retry the same request.';
export const doctorBookingStale =
  'Doctor booking status changed. Refresh and review the latest status before saving.';

export function checkedDoctorBookingChange(value: unknown, doctorId: string): DoctorBookingChange {
  check(
    object(value) &&
      uuid(value.id) &&
      value.doctorId === doctorId &&
      text(value.doctorName) &&
      typeof value.before === 'boolean' &&
      typeof value.after === 'boolean' &&
      value.before !== value.after &&
      text(value.reason) &&
      value.reason === value.reason.trim() &&
      value.reason.length <= 1000 &&
      text(value.createdByName) &&
      text(value.createdAt) &&
      Number.isFinite(Date.parse(value.createdAt)),
  );
  return {
    id: value.id as string,
    doctorId,
    doctorName: value.doctorName,
    before: value.before,
    after: value.after,
    reason: value.reason,
    createdByName: value.createdByName,
    createdAt: value.createdAt,
  };
}
export function checkedDoctorBookingContext(
  value: unknown,
  doctorId: string,
): DoctorBookingContext {
  check(
    object(value) &&
      object(value.doctor) &&
      value.doctor.id === doctorId &&
      text(value.doctor.name) &&
      typeof value.acceptingNewBookings === 'boolean' &&
      hash(value.revision),
  );
  const latestChange =
    value.latestChange === null ? null : checkedDoctorBookingChange(value.latestChange, doctorId);
  check(
    latestChange ? latestChange.after === value.acceptingNewBookings : value.acceptingNewBookings,
  );
  return {
    doctor: { id: doctorId, name: value.doctor.name },
    acceptingNewBookings: value.acceptingNewBookings,
    revision: value.revision as string,
    latestChange,
  };
}
export interface DoctorBookingAttempt {
  actorId: string;
  source: DoctorBookingContext;
  body: DoctorBookingInput;
}
export function checkedDoctorBookingMutation(
  value: unknown,
  sent: DoctorBookingAttempt,
): DoctorBookingMutation {
  check(object(value) && object(value.receipt));
  const doctorId = sent.source.doctor.id,
    context = checkedDoctorBookingContext(value.context, doctorId),
    change = checkedDoctorBookingChange(value.change, doctorId),
    receipt = value.receipt;
  check(
    receipt.actorId === sent.actorId &&
      receipt.requestId === sent.body.requestId &&
      receipt.doctorId === doctorId &&
      receipt.expectedRevision === sent.body.expectedRevision &&
      sent.body.expectedRevision === sent.source.revision &&
      receipt.changeId === change.id &&
      change.before === sent.source.acceptingNewBookings &&
      change.after === sent.body.acceptingNewBookings &&
      change.reason === sent.body.reason &&
      change.id !== sent.source.latestChange?.id &&
      context.latestChange !== null &&
      context.revision !== sent.source.revision,
  );
  if (context.latestChange?.id === change.id)
    check(JSON.stringify(context.latestChange) === JSON.stringify(change));
  return {
    context,
    change,
    receipt: {
      actorId: sent.actorId,
      requestId: sent.body.requestId,
      doctorId,
      expectedRevision: sent.body.expectedRevision,
      changeId: change.id,
    },
  };
}
export function checkedDoctorBookingHistory(
  value: unknown,
  doctorId: string,
  page: number,
): DoctorBookingHistory {
  check(
    object(value) &&
      count(value.total) &&
      value.pageSize === 25 &&
      value.totalPages === Math.max(1, Math.ceil(Number(value.total) / 25)) &&
      value.page === Math.min(page, Number(value.totalPages)) &&
      Array.isArray(value.items),
  );
  const items = value.items.map((item) => checkedDoctorBookingChange(item, doctorId));
  check(
    items.length ===
      Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25)) &&
      new Set(items.map((item) => item.id)).size === items.length &&
      items.every(
        (item, index) =>
          index === 0 ||
          item.createdAt < items[index - 1].createdAt ||
          (item.createdAt === items[index - 1].createdAt && item.id < items[index - 1].id),
      ),
  );
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}

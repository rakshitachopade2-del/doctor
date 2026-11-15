import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError, useSession } from '../lib';
import type {
  AppointmentBookingInput,
  AppointmentBookingResult,
} from '../../shared/appointment-booking';
import { checkedVisitAppointment, visitMinutes, visitPolicy } from './visit-duration-helpers';

export type AppointmentBookingAttempt = { actorId: string; body: AppointmentBookingInput };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const bad = () =>
  new Error('The response did not confirm this booking. Retry the same submitted request.');

export function checkedAppointmentBookingResult(
  value: unknown,
  input: AppointmentBookingInput,
  actorId: string,
): AppointmentBookingResult {
  if (!object(value) || !object(value.booking) || !object(value.receipt)) throw bad();
  const booking = value.booking,
    receipt = value.receipt;
  const original = checkedVisitAppointment(booking.appointment),
    current = checkedVisitAppointment(value.appointment, original.id);
  if (
    !uuid(booking.id) ||
    !uuid(original.id) ||
    booking.waitlistId !== (input.waitlistId?.trim() ?? null) ||
    booking.patientConfirmed !== (input.patientConfirmed === true) ||
    booking.createdById !== actorId ||
    !text(booking.createdByName) ||
    !['patient', 'admin', 'doctor', 'receptionist'].includes(booking.createdByRole as string) ||
    booking.createdAt !== original.createdAt ||
    original.patientId !== input.patientId.trim() ||
    original.doctorId !== input.doctorId.trim() ||
    original.date !== input.date ||
    original.time !== input.time ||
    original.mode !== input.mode ||
    original.reason !== input.reason.trim() ||
    original.status !== 'scheduled' ||
    visitPolicy(original) !== 'schedule' ||
    ![15, 20, 30, 45, 60].includes(original.durationMinutes ?? 0) ||
    current.patientId !== original.patientId ||
    current.createdAt !== original.createdAt ||
    receipt.requestId !== input.requestId.toLowerCase() ||
    !uuid(receipt.requestId) ||
    receipt.actorId !== actorId ||
    receipt.patientId !== original.patientId ||
    receipt.bookingId !== booking.id ||
    receipt.appointmentId !== original.id
  )
    throw bad();
  return {
    appointment: current,
    booking: { ...booking, appointment: original },
    receipt,
  } as unknown as AppointmentBookingResult;
}

export function isAppointmentBookingNotCreated(
  error: unknown,
  input: AppointmentBookingInput,
  actorId: string,
) {
  if (!(error instanceof ApiError) || ![400, 404, 409].includes(error.status)) return false;
  const value = error.responseData;
  return (
    object(value) &&
    text(value.error) &&
    value.bookingOutcome === 'not-created' &&
    value.requestId === input.requestId.toLowerCase() &&
    value.actorId === actorId &&
    value.patientId === input.patientId.trim()
  );
}

export async function requestAppointmentBooking(
  input: AppointmentBookingInput,
  options: {
    actorId: string;
    isCurrent: () => boolean;
    signal?: AbortSignal;
  },
) {
  const response = await api<unknown>('/api/appointment-bookings', {
    method: 'POST',
    body: input,
    isCurrent: options.isCurrent,
    signal: options.signal,
  });
  return checkedAppointmentBookingResult(response, input, options.actorId);
}

export function appointmentBookingHasChanged(result: AppointmentBookingResult) {
  const original = result.booking.appointment,
    current = result.appointment;
  return (
    (
      [
        'date',
        'time',
        'doctorId',
        'doctorName',
        'patientName',
        'mode',
        'reason',
        'status',
        'fee',
      ] as const
    ).some((key) => original[key] !== current[key]) ||
    visitMinutes(original) !== visitMinutes(current) ||
    visitPolicy(original) !== visitPolicy(current)
  );
}

/** A response belongs to the initiating account and history entry, even after Back/Forward. */
export function useAppointmentBookingGuard() {
  const location = useLocation();
  const { session } = useSession();
  const origin = useRef({ key: location.key, actorId: session.user?.id });
  origin.current = { key: location.key, actorId: session.user?.id };
  const mounted = useRef(false),
    generation = useRef(0);
  useLayoutEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      generation.current++;
    };
    window.addEventListener('popstate', invalidate);
    window.addEventListener('hashchange', invalidate);
    window.addEventListener('derma:session-invalidated', invalidate);
    window.addEventListener('derma:session-expired', invalidate);
    return () => {
      mounted.current = false;
      invalidate();
      window.removeEventListener('popstate', invalidate);
      window.removeEventListener('hashchange', invalidate);
      window.removeEventListener('derma:session-invalidated', invalidate);
      window.removeEventListener('derma:session-expired', invalidate);
    };
  }, [location.key, session.user?.id]);
  return useCallback(() => {
    const captured = origin.current,
      serial = generation.current,
      href = window.location.href,
      nativeKey = window.history.state?.key;
    return () =>
      mounted.current &&
      generation.current === serial &&
      origin.current.key === captured.key &&
      origin.current.actorId === captured.actorId &&
      window.location.href === href &&
      window.history.state?.key === nativeKey;
  }, []);
}

/** Guard private supporting reads before api can apply an obsolete 401 to another route. */
export function useAppointmentBookingData<T>(path: string | null, check: (value: unknown) => T) {
  const location = useLocation(),
    { session } = useSession();
  const capture = useAppointmentBookingGuard();
  const [state, setState] = useState<{
    identity: string;
    data: T | null;
    loading: boolean;
    error: string;
  }>({
    identity: '',
    data: null,
    loading: !!path,
    error: '',
  });
  const identity = JSON.stringify([path, location.key, session.user?.id]);
  const active = useRef(identity),
    validator = useRef(check),
    generation = useRef(0);
  active.current = identity;
  validator.current = check;
  const reload = useCallback(async () => {
    if (active.current !== identity) return null;
    const isOrigin = capture(),
      serial = ++generation.current;
    const current = () =>
      isOrigin() && active.current === identity && generation.current === serial;
    setState({ identity, data: null, loading: !!path, error: '' });
    if (!path) return null;
    try {
      const data = validator.current(await api<unknown>(path, { isCurrent: current }));
      if (current()) {
        setState({ identity, data, loading: false, error: '' });
        return data;
      }
    } catch (error) {
      if (current())
        setState({
          identity,
          data: null,
          loading: false,
          error:
            error instanceof Error ? error.message : 'The booking information could not be loaded.',
        });
    }
    return null;
  }, [identity, path, capture]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return state.identity === identity
    ? { ...state, reload }
    : { identity, data: null, loading: !!path, error: '', reload };
}

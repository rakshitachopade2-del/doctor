import { useEffect, useRef } from 'react';
import type {
  AppointmentSeries,
  AppointmentSeriesDetail,
  AppointmentSeriesInput,
  AppointmentSeriesPage,
  AppointmentSeriesPreview,
} from '../../shared/appointment-series';
import {
  checkedVisitAppointment,
  validCustomMinutes,
  visitDate,
  visitMinutes,
  visitPolicy,
  visitTime,
} from './visit-duration-helpers';

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
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const seriesFailure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The appointment series response could not be confirmed. Please try again.';
const bad = () =>
  new Error(
    'The response did not confirm this appointment series. Refresh the preview or retry the same submitted request.',
  );
export const seriesStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
export const seriesCadence = (weeks: number) =>
  weeks === 1 ? 'Weekly' : weeks === 2 ? 'Every two weeks' : 'Every four weeks';
const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const seriesDate = (firstDate: string, index: number, weeks: number) =>
  shiftDate(firstDate, index * weeks * 7);
export function seriesEnd(date: string, time: string, minutes: number) {
  const d = new Date(Date.parse(`${date}T${time}:00Z`) + minutes * 60000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
export function seriesInputEqual(a: AppointmentSeriesInput, b: AppointmentSeriesInput) {
  return [
    'patientId',
    'doctorId',
    'mode',
    'reason',
    'firstDate',
    'time',
    'count',
    'intervalWeeks',
    'durationPolicy',
    'durationMinutes',
  ].every(
    (key) => a[key as keyof AppointmentSeriesInput] === b[key as keyof AppointmentSeriesInput],
  );
}
function checkedInput(value: unknown): AppointmentSeriesInput {
  if (
    !object(value) ||
    !text(value.patientId) ||
    !text(value.doctorId) ||
    !['in-person', 'online'].includes(value.mode as string) ||
    !text(value.reason) ||
    value.reason !== value.reason.trim() ||
    value.reason.length > 300 ||
    !visitDate(value.firstDate) ||
    !visitTime(value.time) ||
    !Number.isInteger(value.count) ||
    Number(value.count) < 2 ||
    Number(value.count) > 12 ||
    ![1, 2, 4].includes(value.intervalWeeks as number) ||
    !['schedule', 'custom'].includes(value.durationPolicy as string)
  )
    throw bad();
  if (
    value.durationPolicy === 'custom'
      ? !validCustomMinutes(Number(value.durationMinutes))
      : value.durationMinutes !== undefined
  )
    throw bad();
  return value as unknown as AppointmentSeriesInput;
}
function checkedMetadata(value: Record<string, unknown>, input: AppointmentSeriesInput) {
  if (
    !object(value.patient) ||
    value.patient.id !== input.patientId ||
    !text(value.patient.name) ||
    typeof value.patient.phone !== 'string' ||
    !object(value.doctor) ||
    value.doctor.id !== input.doctorId ||
    !text(value.doctor.name) ||
    !amount(value.doctor.fee) ||
    !Number.isInteger(value.durationMinutes) ||
    Number(value.durationMinutes) < 1 ||
    Number(value.durationMinutes) > 240 ||
    (input.durationPolicy === 'custom' && value.durationMinutes !== input.durationMinutes) ||
    (input.durationPolicy === 'schedule' &&
      ![15, 20, 30, 45, 60].includes(Number(value.durationMinutes)))
  )
    throw bad();
}
export function checkedSeriesPreview(
  value: unknown,
  sent: AppointmentSeriesInput,
): AppointmentSeriesPreview {
  if (!object(value)) throw bad();
  const input = checkedInput(value.input);
  checkedMetadata(value, input);
  if (
    !seriesInputEqual(input, sent) ||
    !visitDate(value.clinicDate) ||
    !visitDate(value.horizonEndDate) ||
    shiftDate(value.clinicDate, 180) !== value.horizonEndDate ||
    !timestamp(value.generatedAt) ||
    !revision(value.revision) ||
    typeof value.canBook !== 'boolean' ||
    !Array.isArray(value.visits) ||
    value.visits.length !== input.count
  )
    throw bad();
  const visits = value.visits.map((row, index) => {
    const date = seriesDate(input.firstDate, index, input.intervalWeeks),
      end = seriesEnd(date, input.time, Number(value.durationMinutes));
    if (
      !object(row) ||
      row.position !== index + 1 ||
      row.date !== date ||
      row.time !== input.time ||
      row.durationMinutes !== value.durationMinutes ||
      row.endDate !== end.date ||
      row.endTime !== end.time ||
      typeof row.available !== 'boolean' ||
      (row.available ? row.blockedReason !== null : !text(row.blockedReason))
    )
      throw bad();
    return row;
  });
  if (value.canBook !== visits.every((visit) => visit.available)) throw bad();
  return value as unknown as AppointmentSeriesPreview;
}
function checkedSeries(value: unknown, id?: string): AppointmentSeries {
  if (
    !object(value) ||
    !text(value.id) ||
    (id !== undefined && value.id !== id) ||
    !uuid(value.requestId) ||
    !revision(value.expectedRevision) ||
    value.patientConfirmed !== true ||
    typeof value.privateNote !== 'string' ||
    value.privateNote.length > 1000 ||
    !text(value.createdById) ||
    !text(value.createdByName) ||
    !['admin', 'doctor', 'receptionist'].includes(value.createdByRole as string) ||
    !timestamp(value.createdAt) ||
    !Array.isArray(value.bookedAppointments)
  )
    throw bad();
  const input = checkedInput(value.input);
  checkedMetadata(value, input);
  if (value.bookedAppointments.length !== input.count) throw bad();
  const appointments = value.bookedAppointments.map((item, index) => {
    const appointment = checkedVisitAppointment(item),
      patient = value.patient as AppointmentSeries['patient'],
      doctor = value.doctor as AppointmentSeries['doctor'];
    if (
      appointment.patientId !== input.patientId ||
      appointment.doctorId !== input.doctorId ||
      appointment.patientName !== patient.name ||
      appointment.doctorName !== doctor.name ||
      appointment.date !== seriesDate(input.firstDate, index, input.intervalWeeks) ||
      appointment.time !== input.time ||
      appointment.mode !== input.mode ||
      appointment.reason !== input.reason ||
      appointment.fee !== doctor.fee ||
      visitMinutes(appointment) !== value.durationMinutes ||
      visitPolicy(appointment) !== input.durationPolicy ||
      appointment.status !== 'scheduled' ||
      appointment.createdAt !== value.createdAt
    )
      throw bad();
    return appointment;
  });
  if (new Set(appointments.map((a) => a.id)).size !== appointments.length) throw bad();
  return value as unknown as AppointmentSeries;
}
export function checkedSeriesDetail(value: unknown, id?: string): AppointmentSeriesDetail {
  if (!object(value) || !Array.isArray(value.appointments)) throw bad();
  const series = checkedSeries(value.series, id);
  if (value.appointments.length !== series.input.count) throw bad();
  const appointments = value.appointments.map((item, index) => {
    const original = series.bookedAppointments[index],
      appointment = checkedVisitAppointment(item, original.id);
    if (
      appointment.patientId !== original.patientId ||
      appointment.createdAt !== original.createdAt
    )
      throw bad();
    return appointment;
  });
  return { series, appointments };
}
export type SeriesAttempt = {
  preview: AppointmentSeriesPreview;
  actorId: string;
  actorRole: 'admin' | 'doctor' | 'receptionist';
  body: {
    input: AppointmentSeriesInput;
    expectedRevision: string;
    patientConfirmed: true;
    privateNote?: string;
    requestId: string;
  };
};
export function checkedSeriesBooking(value: unknown, sent: SeriesAttempt) {
  const detail = checkedSeriesDetail(value),
    series = detail.series,
    preview = sent.preview;
  if (
    !preview.canBook ||
    !seriesInputEqual(series.input, sent.body.input) ||
    series.expectedRevision !== sent.body.expectedRevision ||
    series.expectedRevision !== preview.revision ||
    series.requestId !== sent.body.requestId ||
    series.createdById !== sent.actorId ||
    series.createdByRole !== sent.actorRole ||
    series.privateNote !== (sent.body.privateNote ?? '') ||
    series.durationMinutes !== preview.durationMinutes ||
    series.patient.id !== preview.patient.id ||
    series.patient.name !== preview.patient.name ||
    series.patient.phone !== preview.patient.phone ||
    series.doctor.id !== preview.doctor.id ||
    series.doctor.name !== preview.doctor.name ||
    series.doctor.fee !== preview.doctor.fee
  )
    throw bad();
  return detail;
}
export function checkedSeriesPage(
  value: unknown,
  filters: AppointmentSeriesPage['filters'],
  page: number,
  pageSize: number,
): AppointmentSeriesPage {
  if (
    !object(value) ||
    !object(value.filters) ||
    value.filters.q !== filters.q ||
    value.filters.patientId !== filters.patientId ||
    value.filters.doctorId !== filters.doctorId ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0 ||
    value.pageSize !== pageSize ||
    value.totalPages !== Math.max(1, Math.ceil(Number(value.total) / pageSize)) ||
    value.page !== Math.min(page, Number(value.totalPages)) ||
    !Array.isArray(value.items) ||
    value.items.length !==
      Math.min(pageSize, Math.max(0, Number(value.total) - (Number(value.page) - 1) * pageSize))
  )
    throw bad();
  const items = value.items.map((item) => {
    if (
      !object(item) ||
      !['id', 'patientId', 'patientName', 'doctorId', 'doctorName', 'createdByName'].every((key) =>
        text(item[key]),
      ) ||
      !visitDate(item.firstDate) ||
      !visitDate(item.lastDate) ||
      !visitTime(item.time) ||
      !Number.isInteger(item.count) ||
      Number(item.count) < 2 ||
      Number(item.count) > 12 ||
      ![1, 2, 4].includes(item.intervalWeeks as number) ||
      item.lastDate !==
        seriesDate(item.firstDate, Number(item.count) - 1, Number(item.intervalWeeks)) ||
      !['in-person', 'online'].includes(item.mode as string) ||
      !['schedule', 'custom'].includes(item.durationPolicy as string) ||
      !Number.isInteger(item.durationMinutes) ||
      Number(item.durationMinutes) < 1 ||
      Number(item.durationMinutes) > 240 ||
      (item.durationPolicy === 'custom' && !validCustomMinutes(Number(item.durationMinutes))) ||
      !timestamp(item.createdAt)
    )
      throw bad();
    return item;
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) throw bad();
  return value as unknown as AppointmentSeriesPage;
}
export function useSeriesGuard() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const href = window.location.href,
      key = window.history.state?.key ?? null;
    return () =>
      mounted.current &&
      window.location.href === href &&
      (window.history.state?.key ?? null) === key;
  };
}

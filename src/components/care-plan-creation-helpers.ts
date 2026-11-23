import type {
  CarePlanCreationCommand,
  CarePlanFields,
  CreatedCarePlan,
} from '../../shared/care-plan-creation';
import type { Medication } from '../../shared/types';
import { ApiError } from '../lib';

export type CarePlanAttempt = {
  command: CarePlanCreationCommand;
  patientName: string;
  doctorName: string;
};
export const planLabels = {
  title: 'Plan title',
  instructions: 'Instructions',
  startDate: 'Start date',
  endDate: 'End / review date',
  followUpDate: 'Follow-up date',
  cost: 'Expected cost',
  expectations: 'What to expect',
  warnings: 'Precautions and when to contact the clinic',
} satisfies Record<Exclude<keyof CarePlanFields, 'medications'>, string>;
export const medicationLabels = {
  name: 'Medication / treatment name',
  instructions: 'Dose and instructions',
  schedule: 'Schedule',
  duration: 'Duration',
  warnings: 'Item-specific warnings',
} satisfies Record<keyof Medication, string>;
export const planKeys = Object.keys(planLabels) as (keyof typeof planLabels)[];
export const medicationKeys = Object.keys(medicationLabels) as (keyof Medication)[];

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

export function reviewedFields(fields: CarePlanFields): CarePlanFields {
  const normalized = { ...fields };
  for (const key of planKeys) normalized[key] = fields[key].trim();
  normalized.medications = fields.medications.map((item) => {
    const value = { ...item };
    for (const key of medicationKeys) value[key] = item[key].trim();
    if (!value.name || !value.instructions || !value.schedule || !value.duration)
      throw new Error(
        'Enter the name, instructions, schedule and duration for each treatment item.',
      );
    return value;
  });
  if (!normalized.title || !normalized.instructions || !normalized.warnings)
    throw new Error('Enter a plan title, instructions and precautions before reviewing.');
  for (const value of [normalized.startDate, normalized.endDate, normalized.followUpDate]) {
    if (
      !/^\d{4}-\d\d-\d\d$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new Error('Enter a valid start, end and follow-up date.');
  }
  if (normalized.endDate < normalized.startDate || normalized.followUpDate < normalized.startDate)
    throw new Error('End and follow-up dates must be on or after the start date.');
  return normalized;
}

function matchesFields(
  value: unknown,
  expected: CarePlanFields,
): value is CarePlanFields & Record<string, unknown> {
  if (!object(value) || !planKeys.every((key) => value[key] === expected[key])) return false;
  const items = value.medications;
  return (
    Array.isArray(items) &&
    items.length === expected.medications.length &&
    items.every(
      (item, index) =>
        object(item) &&
        medicationKeys.every((key) => item[key] === expected.medications[index][key]) &&
        Object.keys(item).length === medicationKeys.length,
    )
  );
}

export function confirmedCarePlan(
  value: unknown,
  command: CarePlanCreationCommand,
  actorId: string,
): CreatedCarePlan | null {
  if (!object(value) || !object(value.receipt)) return null;
  const { receipt } = value,
    plan = receipt.plan;
  if (
    receipt.requestId !== command.requestId ||
    receipt.actorId !== actorId ||
    receipt.doctorId !== command.doctorId ||
    receipt.patientId !== command.patientId ||
    !matchesFields(plan, command) ||
    plan.status !== 'active' ||
    plan.doctorId !== command.doctorId ||
    plan.patientId !== command.patientId ||
    !nonempty(plan.patientName) ||
    !nonempty(plan.doctorName) ||
    typeof plan.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(plan.id) ||
    typeof plan.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(plan.createdAt)) ||
    new Date(plan.createdAt).toISOString() !== plan.createdAt ||
    ['effectiveStatus', 'effectiveFollowUpDate', 'followUpRevision', 'latestReview'].some(
      (key) => key in plan,
    )
  )
    return null;
  return {
    ...plan,
    id: plan.id,
    doctorId: command.doctorId,
    patientId: command.patientId,
    patientName: plan.patientName,
    doctorName: plan.doctorName,
    status: plan.status,
    createdAt: plan.createdAt,
  };
}

export function carePlanNotCreated(
  error: unknown,
  command: CarePlanCreationCommand,
  actorId: string,
) {
  if (!(error instanceof ApiError) || error.status !== 409 || !object(error.responseData))
    return false;
  const result = error.responseData,
    submitted = result.command;
  return (
    result.code === 'CARE_PLAN_NOT_CREATED' &&
    result.actorId === actorId &&
    nonempty(result.message) &&
    matchesFields(submitted, command) &&
    submitted.requestId === command.requestId &&
    submitted.patientId === command.patientId &&
    submitted.doctorId === command.doctorId &&
    submitted.reviewedConfirmed === true
  );
}

export function linkedDoctor(value: unknown, doctorId: string): { id: string; name: string } {
  const doctor = Array.isArray(value) && value.find((item) => object(item) && item.id === doctorId);
  if (!object(doctor) || !nonempty(doctor.name))
    throw new Error('Could not find the linked clinician. Refresh to try again.');
  return { id: doctorId, name: doctor.name };
}

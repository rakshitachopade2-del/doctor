import type { IntakeAnswers, IntakeSubmissionCommand } from '../../shared/intake-submission';
import type { Intake } from '../../shared/types';
import { ApiError } from '../lib';

export type IntakeValues = Omit<IntakeAnswers, 'consent'>;
export const intakeLabels: Record<keyof IntakeValues, string> = {
  concern: 'Main concern',
  location: 'Area affected',
  duration: 'How long it has been present',
  symptoms: 'What you have noticed',
  triggers: 'Possible triggers',
  previousTreatment: 'Previous treatments',
  medications: 'Current medicines or supplements',
  allergies: 'Allergies or sensitivities',
  goals: 'What matters to you',
};
export const intakeKeys = Object.keys(intakeLabels) as (keyof IntakeValues)[];

export function intakeValues(value?: IntakeValues): IntakeValues {
  return Object.fromEntries(
    intakeKeys.map((key) => [key, value?.[key].trim() ?? '']),
  ) as IntakeValues;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function matchesAnswers(
  value: unknown,
  command: IntakeSubmissionCommand,
): value is IntakeAnswers & Record<string, unknown> {
  return (
    object(value) &&
    value.consent === true &&
    intakeKeys.every((key) => value[key] === command[key])
  );
}

export function confirmedIntake(
  result: unknown,
  command: IntakeSubmissionCommand,
  actorId: string,
): Intake | null {
  if (!object(result) || !object(result.receipt)) return null;
  const { receipt } = result;
  const saved = receipt.intake;
  if (
    receipt.requestId !== command.requestId ||
    receipt.patientId !== command.patientId ||
    receipt.actorId !== actorId ||
    !matchesAnswers(saved, command) ||
    saved.patientId !== command.patientId ||
    typeof saved.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved.id) ||
    typeof saved.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(saved.createdAt)) ||
    new Date(saved.createdAt).toISOString() !== saved.createdAt
  )
    return null;
  return {
    ...intakeValues(saved),
    id: saved.id,
    patientId: saved.patientId,
    createdAt: saved.createdAt,
    consent: saved.consent,
  };
}

export function intakeNotSubmitted(
  error: unknown,
  command: IntakeSubmissionCommand,
  actorId: string,
) {
  if (!(error instanceof ApiError) || error.status !== 403 || !object(error.responseData))
    return false;
  const result = error.responseData;
  return (
    result.code === 'INTAKE_NOT_SUBMITTED' &&
    result.requestId === command.requestId &&
    result.patientId === command.patientId &&
    result.actorId === actorId &&
    matchesAnswers(result.answers, command) &&
    typeof result.message === 'string' &&
    !!result.message.trim()
  );
}

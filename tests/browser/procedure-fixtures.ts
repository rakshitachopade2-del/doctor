import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { PatientClinicalWorkflows, ProcedureRecord } from '../../shared/clinical';
import { type Actor, post, read } from './workflow-fixtures';

export {
  type Actor,
  button,
  checkbox,
  deferred,
  dialog,
  field,
  login,
  mobile,
  post,
  read,
  test,
  title,
} from './workflow-fixtures';

export const patientId = 'patient-ananya';
export const portal = '/my-care/record?tab=workflows';
export const clinic = '/clinic/patients/' + patientId + '?tab=workup';
export const workflows = '/api/patients/' + patientId + '/clinical-workflows';
export const path = (plan: ProcedureRecord) => '/api/procedures/' + plan.id;
export async function planFor(admin: Actor, appointmentId: string | null = null) {
  return post<ProcedureRecord>(admin, '/api/procedures', {
    patientId,
    appointmentId,
    title: 'Procedure ' + randomUUID().slice(0, 8),
    indication: 'Synthetic procedure workflow.',
    benefits: 'Discussed potential benefit.',
    risks: 'Discussed potential risk.',
    alternatives: 'Discussed other options.',
    aftercare: 'Synthetic aftercare.',
    estimatedCost: 'No charge for this test.',
  });
}
export async function current(who: Actor, plan: ProcedureRecord) {
  const record = await read<PatientClinicalWorkflows>(who, workflows);
  return record.procedures.find((p) => p.id === plan.id)!;
}
export function card(page: Page, plan: ProcedureRecord, role: 'patient' | 'doctor' = 'patient') {
  return page
    .locator(role === 'patient' ? '.patient-procedure-card' : '.cw-procedure')
    .filter({ has: page.getByRole('heading', { name: plan.title, exact: true }) });
}

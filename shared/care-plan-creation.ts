import type { CarePlan } from './types';

export type CarePlanFields = Pick<
  CarePlan,
  | 'title'
  | 'instructions'
  | 'expectations'
  | 'warnings'
  | 'cost'
  | 'startDate'
  | 'endDate'
  | 'followUpDate'
  | 'medications'
>;
export interface CarePlanCreationCommand extends CarePlanFields {
  requestId: string;
  patientId: string;
  doctorId: string;
  reviewedConfirmed: true;
}
export interface CreatedCarePlan extends CarePlanFields {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName: string;
  patientName: string;
  status: 'active';
  createdAt: string;
}
export interface CarePlanCreationResult {
  receipt: {
    requestId: string;
    actorId: string;
    patientId: string;
    doctorId: string;
    plan: CreatedCarePlan;
  };
}
export interface CarePlanNotCreated {
  code: 'CARE_PLAN_NOT_CREATED';
  actorId: string;
  command: CarePlanCreationCommand;
  message: string;
}

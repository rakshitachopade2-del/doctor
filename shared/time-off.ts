import type { ScheduleClosure } from './scheduling';

export type TimeOffValues = Omit<ScheduleClosure, 'id' | 'createdAt'>;
export type TimeOffEditValues = Omit<TimeOffValues, 'doctorId'>;
export interface TimeOffSnapshot {
  closure: ScheduleClosure;
  status: 'active' | 'cancelled';
}
/** Private manager history; operational closure reasons remain visible to staff. */
export interface TimeOffChange {
  id: string;
  closureId: string;
  doctorId: string | null;
  doctorName: string | null;
  source: 'reviewed' | 'legacy';
  action: 'created' | 'edited' | 'cancelled';
  before: TimeOffSnapshot | null;
  after: TimeOffSnapshot;
  changeReason: string | null;
  createdByName: string;
  createdByRole: 'admin' | 'doctor';
  createdAt: string;
}
export interface TimeOffContext extends TimeOffSnapshot {
  doctor: { id: string; name: string } | null;
  revision: string;
  /** Imported existing closures have no invented author/event. */
  latestChange: TimeOffChange | null;
}
export interface TimeOffCreateInput {
  closure: TimeOffValues;
  requestId: string;
}
export interface TimeOffEditInput {
  closure: TimeOffEditValues;
  changeReason: string;
  expectedRevision: string;
  requestId: string;
}
export interface TimeOffCancelInput {
  changeReason: string;
  expectedRevision: string;
  requestId: string;
}
export interface TimeOffMutation {
  context: TimeOffContext;
  change: TimeOffChange;
  receipt: {
    requestId: string;
    actorId: string;
    operation: 'create' | 'edit' | 'cancel';
    closureId: string;
    expectedRevision: string | null;
    changeId: string;
  };
}
export interface TimeOffPage {
  items: TimeOffSnapshot[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface TimeOffHistory {
  items: TimeOffChange[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

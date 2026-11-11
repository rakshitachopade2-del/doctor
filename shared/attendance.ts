import type { Role } from './types';
import type { SearchPage } from './record-search';

export type StaffRole = Exclude<Role, 'patient'>;
export interface AttendanceStaff {
  id: string;
  name: string;
  role: StaffRole;
  active: boolean;
}
export interface AttendanceState {
  startedAt: string;
  endedAt: string | null;
  voided: boolean;
}
export interface AttendanceShift {
  id: string;
  userId: string;
  /** Identity snapshots captured when this entry was created. */
  staffName: string;
  staffRole: StaffRole;
  source: 'clock' | 'manual';
  startedAt: string;
  endedAt: string | null;
  status: 'open' | 'closed' | 'voided';
  /** Whole elapsed seconds; open and voided entries contribute no time. */
  recordedSeconds: number | null;
  createdAt: string;
  revision: string;
}
export type AttendanceOperation = 'clock-in' | 'clock-out' | 'manual-entry' | 'correction' | 'void';
export interface AttendanceEvent {
  id: string;
  shiftId: string;
  userId: string;
  operation: AttendanceOperation;
  requestId: string;
  expectedRevision: string;
  before: AttendanceState | null;
  after: AttendanceState;
  reason: string;
  createdById: string;
  createdByName: string;
  createdByRole: StaffRole;
  createdAt: string;
}
export interface AttendanceDetail {
  shift: AttendanceShift;
  events: AttendanceEvent[];
}
export interface AttendanceContext {
  staff: AttendanceStaff;
  revision: string;
  openShift: AttendanceShift | null;
  serverNow: string;
  timezone: 'Asia/Kolkata';
}
export interface AttendanceMutation {
  /** Current effective shift, including changes after an exact request replay. */
  shift: AttendanceShift;
  /** Immutable receipt for this exact command, even after later changes. */
  event: AttendanceEvent;
}
export interface AttendanceReport extends SearchPage<AttendanceShift> {
  from: string;
  to: string;
  /** Null means all staff (administrator only). Other users always receive their own ID. */
  userId: string | null;
  status: 'all' | 'open' | 'closed' | 'voided';
  timezone: 'Asia/Kolkata';
  generatedAt: string;
  /** Covers the whole filtered result, independent of pagination. */
  revision: string;
  totals: {
    closedShiftCount: number;
    recordedSeconds: number;
    openShiftCount: number;
    voidedShiftCount: number;
  };
}

export interface ScheduleWindow {
  day: number; // Sunday = 0, Saturday = 6
  start: string; // HH:mm in clinic timezone
  end: string;
  mode: 'in-person' | 'online' | 'both';
}
export interface DoctorSchedule {
  doctorId: string;
  durationMinutes: 15 | 20 | 30 | 45 | 60;
  windows: ScheduleWindow[];
  updatedAt: string;
}
export interface ScheduleClosure {
  id: string;
  doctorId: string | null; // null closes the whole clinic
  startDate: string;
  endDate: string;
  startTime: string | null; // both null means all day
  endTime: string | null;
  reason: string;
  createdAt: string;
}
export interface SchedulingData {
  schedules: DoctorSchedule[];
  closures: ScheduleClosure[];
  timezone: string;
  bookingWindowDays: number;
}

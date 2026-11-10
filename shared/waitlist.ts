export type WaitlistStatus = 'waiting' | 'booked' | 'cancelled' | 'expired';

export interface WaitlistEntry {
  id: string;
  patientId: string;
  patientName: string;
  /** Operational contact data is returned only to staff. */
  patientPhone?: string;
  doctorId: string;
  doctorName: string;
  mode: 'in-person' | 'online';
  startDate: string;
  endDate: string;
  reason: string;
  createdAt: string;
  status: WaitlistStatus;
  appointmentId: string | null;
  closedAt: string | null;
  cancellationReason: string | null;
}

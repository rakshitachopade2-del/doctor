/** Private administrator evidence; public profiles expose only acceptingNewBookings. */
export interface DoctorBookingChange {
  id: string;
  doctorId: string;
  doctorName: string;
  before: boolean;
  after: boolean;
  reason: string;
  createdByName: string;
  createdAt: string;
}
export interface DoctorBookingContext {
  doctor: { id: string; name: string };
  acceptingNewBookings: boolean;
  revision: string;
  latestChange: DoctorBookingChange | null;
}
export interface DoctorBookingInput {
  acceptingNewBookings: boolean;
  reason: string;
  expectedRevision: string;
  requestId: string;
}
export interface DoctorBookingMutation {
  context: DoctorBookingContext;
  change: DoctorBookingChange;
  receipt: {
    actorId: string;
    requestId: string;
    doctorId: string;
    expectedRevision: string;
    changeId: string;
  };
}
export interface DoctorBookingHistory {
  items: DoctorBookingChange[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

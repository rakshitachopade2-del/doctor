import type { FollowUpReview, PatientFollowUpReview } from './follow-up';

export type Role = 'admin' | 'doctor' | 'receptionist' | 'patient';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  patientId?: string;
  doctorId?: string;
  active?: boolean;
  mustChangePassword?: boolean;
}
export interface Session {
  user: User | null;
  csrfToken?: string;
  demoMode: boolean;
}
export interface Doctor {
  id: string;
  name: string;
  title: string;
  qualifications: string;
  specialties: string[];
  experience: number;
  fee: number;
  bio: string;
  languages: string[];
  color: string;
  appointmentDurationMinutes?: number;
}
export interface Patient {
  id: string;
  name: string;
  email: string;
  phone: string;
  dob: string;
  gender: string;
  allergies: string;
  createdAt: string;
}
export type AppointmentStatus =
  'scheduled' | 'checked-in' | 'in-consultation' | 'completed' | 'cancelled' | 'no-show';
export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  date: string;
  time: string;
  mode: 'in-person' | 'online';
  reason: string;
  status: AppointmentStatus;
  patientName: string;
  doctorName: string;
  fee: number;
  durationMinutes?: number;
  createdAt: string;
}
export interface Intake {
  id: string;
  patientId: string;
  concern: string;
  location: string;
  duration: string;
  symptoms: string;
  triggers: string;
  previousTreatment: string;
  medications: string;
  allergies: string;
  goals: string;
  consent: boolean;
  createdAt: string;
}
export interface Encounter {
  id: string;
  patientId: string;
  doctorId: string;
  appointmentId?: string;
  history: string;
  examination: string;
  assessment: string;
  investigations: string;
  plan: string;
  createdAt: string;
  doctorName: string;
}
export interface Medication {
  name: string;
  instructions: string;
  schedule: string;
  duration: string;
  warnings: string;
}
export interface CarePlan {
  effectiveStatus?: 'active' | 'completed';
  effectiveFollowUpDate?: string | null;
  followUpRevision?: string;
  latestReview?: FollowUpReview | PatientFollowUpReview | null;
  id: string;
  patientId: string;
  doctorId: string;
  title: string;
  instructions: string;
  expectations: string;
  warnings: string;
  cost: string;
  startDate: string;
  endDate: string;
  followUpDate: string;
  medications: Medication[];
  status: 'active' | 'completed';
  createdAt: string;
  patientName?: string;
  doctorName?: string;
}
export interface CheckIn {
  id: string;
  carePlanId: string;
  patientId: string;
  date: string;
  adherence: 'taken' | 'partial' | 'missed';
  feeling: 'better' | 'same' | 'worse';
  note: string;
  createdAt: string;
}
export interface ClinicalImage {
  id: string;
  patientId: string;
  caption: string;
  category: 'clinical' | 'report';
  mimeType: string;
  createdAt: string;
  url: string;
  consent: boolean;
}
export interface Message {
  id: string;
  patientId: string;
  authorName: string;
  authorRole: Role;
  body: string;
  createdAt: string;
}
export interface PatientRecord {
  patient: Patient;
  appointments: Appointment[];
  intakes: Intake[];
  encounters: Encounter[];
  carePlans: CarePlan[];
  checkIns: CheckIn[];
  images: ClinicalImage[];
  messages: Message[];
}
export interface ClinicSettings {
  name: string;
  tagline: string;
  phone: string;
  email: string;
  address: string;
  hours: string;
  modules: { intake: boolean; images: boolean; followUp: boolean };
  timezone: string;
}
export interface Dashboard {
  date: string;
  appointments: Appointment[];
  stats: {
    appointments: number;
    checkedIn: number;
    patients: number;
    followUps: number;
    completed: number;
    scheduledValue: number;
  };
  weekly: { date: string; count: number }[];
  followUps: CarePlan[];
  recentPatients: Patient[];
}
export interface AuditEntry {
  id: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

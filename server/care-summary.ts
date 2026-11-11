import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type {
  Appointment,
  CarePlan,
  CheckIn,
  ClinicalImage,
  Intake,
  Patient,
  User,
} from '../shared/types.ts';
import type { PatientClinicalWorkflows } from '../shared/clinical.ts';
import type { PatientFollowUpReview } from '../shared/follow-up.ts';
import type { PatientDocument } from '../shared/documents.ts';
import type { Invoice } from '../shared/operations.ts';
import type { ImageAnnotationVersion } from '../shared/image-annotations.ts';
import type { CareSummary, SummaryCarePlan } from '../shared/care-summary.ts';
import type { PatientAllergyChange } from '../shared/patient-profile.ts';
import { list, nowISO, settings, type DB } from './db.ts';

interface SummaryContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  hydratePlans: (plans: CarePlan[], forPatient: boolean) => CarePlan[];
  patientReviews: (carePlanId: string) => PatientFollowUpReview[];
  patientWorkflows: (patientId: string) => PatientClinicalWorkflows;
  publishedAnnotations: (patientId: string) => ImageAnnotationVersion[];
  allergyHistory: (patientId: string) => PatientAllergyChange[];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function registerCareSummary(app: Express, context: SummaryContext) {
  const { db, actor, patientAccess, audit, fail } = context;
  function snapshot(patient: Patient): CareSummary {
    const clinic = settings(db);
    const workflows = context.patientWorkflows(patient.id);
    const carePlans: SummaryCarePlan[] = context
      .hydratePlans(list<CarePlan>(db, 'carePlans', patient.id), true)
      .map((plan) => ({
        id: plan.id,
        patientId: plan.patientId,
        doctorId: plan.doctorId,
        doctorName: plan.doctorName,
        patientName: plan.patientName,
        title: plan.title,
        instructions: plan.instructions,
        expectations: plan.expectations,
        warnings: plan.warnings,
        cost: plan.cost,
        startDate: plan.startDate,
        endDate: plan.endDate,
        followUpDate: plan.followUpDate,
        medications: plan.medications,
        status: plan.status,
        effectiveStatus: plan.effectiveStatus,
        effectiveFollowUpDate: plan.effectiveFollowUpDate,
        createdAt: plan.createdAt,
        reviews: context.patientReviews(plan.id),
      }));
    // Deliberate patient-facing projection even when requested by a clinician.
    // No private record is fetched and then conditionally exposed by caller role.
    const content = {
      schemaVersion: 1 as const,
      audience: 'patient' as const,
      timezone: 'Asia/Kolkata' as const,
      clinic: {
        name: clinic.name,
        address: clinic.address,
        phone: clinic.phone,
        email: clinic.email,
      },
      patient: {
        id: patient.id,
        name: patient.name,
        email: patient.email,
        phone: patient.phone,
        dob: patient.dob,
        gender: patient.gender,
        allergies: patient.allergies,
        allergyStatus: patient.allergyStatus,
        createdAt: patient.createdAt,
      },
      allergyHistory: context.allergyHistory(patient.id),
      appointments: list<Appointment>(db, 'appointments', patient.id).sort((a, b) =>
        `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`),
      ),
      intakes: list<Intake>(db, 'intakes', patient.id),
      carePlans,
      checkIns: list<CheckIn>(db, 'checkIns', patient.id),
      investigations: workflows.investigations,
      procedures: workflows.procedures,
      images: list<ClinicalImage>(db, 'images', patient.id),
      imageAnnotations: context.publishedAnnotations(patient.id),
      documents: list<PatientDocument>(db, 'documents', patient.id),
      invoices: list<Invoice>(db, 'invoices', patient.id),
    };
    return { ...content, generatedAt: nowISO(), revision: digest(JSON.stringify(content)) };
  }
  function produce(req: AuthRequest, download: boolean): CareSummary {
    actor(req, ['patient', 'doctor', 'admin']);
    const expected = download
      ? z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(req.query.revision)
      : undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      const patient = patientAccess(req, String(req.params.id));
      const value = snapshot(patient);
      if (expected && expected !== value.revision)
        fail(
          409,
          'The shared care record has changed. Refresh this summary before downloading it.',
        );
      audit(
        req,
        download ? 'downloaded patient-facing care summary' : 'viewed patient-facing care summary',
        'patient',
        patient.id,
      );
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  app.get('/api/patients/:id/care-summary', (req: AuthRequest, res) => {
    res.json(produce(req, false));
  });
  app.get('/api/patients/:id/care-summary/download', (req: AuthRequest, res) => {
    const summary = produce(req, true);
    const fileId = digest(summary.patient.id).slice(0, 12);
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: summary.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(summary.generatedAt));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="care-summary-${fileId}-${date}.json"`,
    );
    res.type('application/json').send(JSON.stringify(summary, null, 2) + '\n');
  });
}

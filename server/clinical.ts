import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Appointment, Doctor, Encounter, Patient, User } from '../shared/types.ts';
import type {
  EncounterAmendment,
  Investigation,
  InvestigationResult,
  InvestigationReview,
  PatientClinicalWorkflows,
  ProcedureAgreement,
  ProcedureCompletion,
  ProcedureRecord,
} from '../shared/clinical.ts';
import { clinicToday, get, id, insert, list, nowISO, type DB } from './db.ts';
import { notifyPatient, notifyClinicians } from './activity.ts';

interface ClinicalContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  clinicianId: (req: AuthRequest) => string;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type InvestigationOrder = Omit<Investigation, 'results' | 'reviews'>;
type ProcedurePlan = Omit<ProcedureRecord, 'agreements' | 'completion'>;
const required = z.string().trim().min(1).max(300);
const text = z.string().trim().max(8000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Invalid calendar date.',
  );

export function registerClinical(app: Express, context: ClinicalContext) {
  const { db, actor, patientAccess, clinicianId, audit, fail } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS investigations (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigationResults (id TEXT PRIMARY KEY, investigationId TEXT NOT NULL REFERENCES investigations(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigationReviews (id TEXT PRIMARY KEY, investigationId TEXT NOT NULL REFERENCES investigations(id), resultId TEXT NOT NULL REFERENCES investigationResults(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigationPublications (id TEXT PRIMARY KEY REFERENCES investigationReviews(id), publishedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigationCancellations (id TEXT PRIMARY KEY REFERENCES investigations(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS encounterAmendments (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), encounterId TEXT NOT NULL REFERENCES encounters(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedures (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedureAgreements (id TEXT PRIMARY KEY, procedureId TEXT NOT NULL REFERENCES procedures(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedureCompletions (id TEXT PRIMARY KEY REFERENCES procedures(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedureCancellations (id TEXT PRIMARY KEY REFERENCES procedures(id), data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS investigation_results_order ON investigationResults(investigationId);
    CREATE INDEX IF NOT EXISTS investigation_reviews_order ON investigationReviews(investigationId);
    CREATE INDEX IF NOT EXISTS procedure_agreements_order ON procedureAgreements(procedureId);
  `);
  for (const table of [
    'investigations',
    'investigationResults',
    'investigationReviews',
    'investigationPublications',
    'investigationCancellations',
    'encounterAmendments',
    'procedures',
    'procedureAgreements',
    'procedureCompletions',
    'procedureCancellations',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Clinical documentation is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Clinical documentation is append-only'); END;`);
  }
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function events<T>(table: string, ownerColumn: string, ownerId: string): T[] {
    return db
      .prepare(`SELECT data FROM ${table} WHERE ${ownerColumn}=? ORDER BY rowid`)
      .all(ownerId)
      .map((row) => JSON.parse(row.data as string) as T);
  }
  function doctorIdentity(req: AuthRequest) {
    const doctorId = clinicianId(req);
    return { doctorId, doctorName: get<Doctor>(db, 'doctors', doctorId)!.name };
  }
  function investigationAccess(req: AuthRequest, investigationId: string): InvestigationOrder {
    actor(req);
    const order = get<InvestigationOrder>(db, 'investigations', investigationId);
    if (!order) return fail(404, 'Investigation not found.');
    patientAccess(req, order.patientId);
    return order;
  }
  function investigationView(order: InvestigationOrder, forPatient = false): Investigation {
    const results = events<InvestigationResult>(
      'investigationResults',
      'investigationId',
      order.id,
    );
    const reviews = events<InvestigationReview>(
      'investigationReviews',
      'investigationId',
      order.id,
    ).map((review) => ({
      ...review,
      publishedAt:
        (db.prepare('SELECT publishedAt FROM investigationPublications WHERE id=?').get(review.id)
          ?.publishedAt as string | undefined) ?? null,
    }));
    const cancellation = get<{ reason: string }>(db, 'investigationCancellations', order.id);
    const latest = results.at(-1);
    const status = cancellation
      ? 'cancelled'
      : !latest
        ? 'ordered'
        : reviews.some((review) => review.resultId === latest.id)
          ? 'reviewed'
          : 'result-received';
    return {
      ...order,
      status,
      cancellationReason: cancellation?.reason ?? null,
      results,
      reviews: forPatient ? reviews.filter((review) => review.publishedAt !== null) : reviews,
    };
  }
  function procedureAccess(req: AuthRequest, procedureId: string): ProcedurePlan {
    actor(req);
    const plan = get<ProcedurePlan>(db, 'procedures', procedureId);
    if (!plan) return fail(404, 'Procedure not found.');
    patientAccess(req, plan.patientId);
    return plan;
  }
  function procedureView(plan: ProcedurePlan): ProcedureRecord {
    const agreements = events<ProcedureAgreement>('procedureAgreements', 'procedureId', plan.id);
    const completion = get<ProcedureCompletion>(db, 'procedureCompletions', plan.id) ?? null;
    const cancellation = get<{ reason: string }>(db, 'procedureCancellations', plan.id);
    return {
      ...plan,
      status: completion ? 'completed' : cancellation ? 'cancelled' : 'planned',
      cancellationReason: cancellation?.reason ?? null,
      agreements,
      completion,
    };
  }
  function requireOpenInvestigation(order: InvestigationOrder) {
    if (get(db, 'investigationCancellations', order.id))
      fail(
        409,
        'This investigation is cancelled. Create a new order if further testing is needed.',
      );
  }
  function requirePlannedProcedure(plan: ProcedurePlan) {
    if (procedureView(plan).status !== 'planned')
      fail(
        409,
        'This procedure is already completed or cancelled. Its documentation cannot be changed.',
      );
  }
  function validateDocumentLinks(patientId: string, documentIds: string[]) {
    for (const documentId of documentIds) {
      const document = get<{ patientId: string }>(db, 'documents', documentId);
      if (!document || document.patientId !== patientId)
        fail(400, 'Every linked report must belong to this patient.');
    }
  }
  app.get('/api/patients/:id/clinical-workflows', (req: AuthRequest, res) => {
    const patientId = String(req.params.id),
      user = actor(req);
    patientAccess(req, patientId);
    const forPatient = user.role === 'patient';
    const data: PatientClinicalWorkflows = {
      investigations: list<InvestigationOrder>(db, 'investigations', patientId).map((order) =>
        investigationView(order, forPatient),
      ),
      procedures: list<ProcedurePlan>(db, 'procedures', patientId).map(procedureView),
      amendments: forPatient ? [] : list<EncounterAmendment>(db, 'encounterAmendments', patientId),
    };
    audit(req, 'viewed clinical workflows', 'patient', patientId);
    res.json(data);
  });
  app.post('/api/investigations', (req: AuthRequest, res) => {
    const identity = doctorIdentity(req);
    const input = z
      .object({
        patientId: required,
        title: required,
        kind: z.enum(['laboratory', 'pathology', 'imaging', 'other']),
        reason: text.min(1),
        instructions: text.min(1),
        dueDate: date.nullable().optional(),
      })
      .parse(req.body);
    patientAccess(req, input.patientId);
    if (input.dueDate && input.dueDate < clinicToday())
      fail(400, 'Choose today or a future due date.');
    const order: InvestigationOrder = {
      ...input,
      ...identity,
      id: id(),
      dueDate: input.dueDate ?? null,
      status: 'ordered',
      cancellationReason: null,
      createdAt: nowISO(),
    };
    transaction(() => {
      insert(db, 'investigations', order);
      audit(req, 'ordered investigation', 'investigation', order.id);
      notifyPatient(db, order.patientId, `investigation-ordered:${order.id}`, {
        kind: 'investigation',
        title: 'Your clinician requested an investigation',
        detail: order.title,
        href: '/my-care/record?tab=workflows',
      });
    });
    res.status(201).json(investigationView(order));
  });
  app.post('/api/investigations/:id/results', (req: AuthRequest, res) => {
    const user = actor(req);
    if (user.role !== 'patient') doctorIdentity(req);
    const order = investigationAccess(req, String(req.params.id));
    const input = z
      .object({ note: text.default(''), documentIds: z.array(required).max(10).default([]) })
      .refine(
        (value) => value.note.length > 0 || value.documentIds.length > 0,
        'Add a result note or at least one report.',
      )
      .refine(
        (value) => new Set(value.documentIds).size === value.documentIds.length,
        'Do not link the same report more than once.',
      )
      .parse(req.body);
    transaction(() => {
      requireOpenInvestigation(order);
      validateDocumentLinks(order.patientId, input.documentIds);
      const result: InvestigationResult = {
        ...input,
        id: id(),
        investigationId: order.id,
        submittedById: user.id,
        submittedByName: user.name,
        submittedByRole: user.role,
        createdAt: nowISO(),
      };
      db.prepare('INSERT INTO investigationResults(id,investigationId,data) VALUES (?,?,?)').run(
        result.id,
        order.id,
        JSON.stringify(result),
      );
      audit(req, 'submitted unreviewed investigation result', 'investigation', order.id);
      notifyClinicians(
        db,
        order.patientId,
        `investigation-result:${result.id}`,
        {
          kind: 'investigation',
          title: 'An investigation result is ready for review',
          detail: `${get<Patient>(db, 'patients', order.patientId)!.name} · ${order.title}`,
          href: `/clinic/patients/${order.patientId}?tab=workup`,
        },
        { doctorId: order.doctorId, excludeActorId: user.id },
      );
    });
    res.status(201).json(investigationView(order, user.role === 'patient'));
  });
  app.post('/api/investigations/:id/reviews', (req: AuthRequest, res) => {
    const identity = doctorIdentity(req),
      order = investigationAccess(req, String(req.params.id));
    const input = z
      .object({
        resultId: required,
        summary: text.min(1),
        followUp: text.default(''),
        publishToPatient: z.boolean().default(false),
      })
      .parse(req.body);
    transaction(() => {
      requireOpenInvestigation(order);
      const latest = events<InvestigationResult>(
        'investigationResults',
        'investigationId',
        order.id,
      ).at(-1);
      if (!latest || latest.id !== input.resultId)
        fail(
          409,
          'Review the latest submitted result. A newer report may have arrived; refresh the record.',
        );
      const review: InvestigationReview = {
        id: id(),
        investigationId: order.id,
        resultId: latest!.id,
        summary: input.summary,
        followUp: input.followUp,
        ...identity,
        publishedAt: null,
        createdAt: nowISO(),
      };
      db.prepare(
        'INSERT INTO investigationReviews(id,investigationId,resultId,data) VALUES (?,?,?,?)',
      ).run(review.id, order.id, latest!.id, JSON.stringify(review));
      if (input.publishToPatient) {
        db.prepare('INSERT INTO investigationPublications(id,publishedAt) VALUES (?,?)').run(
          review.id,
          nowISO(),
        );
        audit(req, 'published investigation review to patient', 'investigationReview', review.id);
        notifyPatient(db, order.patientId, `investigation-review:${review.id}`, {
          kind: 'investigation',
          title: 'Your clinician shared a report review',
          detail: order.title,
          href: '/my-care/record?tab=workflows',
        });
      }
      audit(req, 'reviewed investigation result', 'investigation', order.id);
    });
    res.status(201).json(investigationView(order));
  });
  app.post('/api/investigations/:id/reviews/:reviewId/publish', (req: AuthRequest, res) => {
    doctorIdentity(req);
    const order = investigationAccess(req, String(req.params.id));
    const review = get<InvestigationReview>(
      db,
      'investigationReviews',
      String(req.params.reviewId),
    );
    if (!review || review.investigationId !== order.id)
      return fail(404, 'Review not found for this investigation.');
    transaction(() => {
      const existing = db
        .prepare('SELECT 1 FROM investigationPublications WHERE id=?')
        .get(review.id);
      if (!existing) {
        db.prepare('INSERT INTO investigationPublications(id,publishedAt) VALUES (?,?)').run(
          review.id,
          nowISO(),
        );
        audit(req, 'published investigation review to patient', 'investigationReview', review.id);
        notifyPatient(db, order.patientId, `investigation-review:${review.id}`, {
          kind: 'investigation',
          title: 'Your clinician shared a report review',
          detail: order.title,
          href: '/my-care/record?tab=workflows',
        });
      }
    });
    res.json(investigationView(order));
  });
  app.post('/api/investigations/:id/cancel', (req: AuthRequest, res) => {
    doctorIdentity(req);
    const order = investigationAccess(req, String(req.params.id));
    const input = z.object({ reason: text.min(1) }).parse(req.body);
    transaction(() => {
      requireOpenInvestigation(order);
      if (investigationView(order).status === 'reviewed')
        fail(
          409,
          'A reviewed investigation is already documented. Create a new order for further testing.',
        );
      db.prepare('INSERT INTO investigationCancellations(id,data) VALUES (?,?)').run(
        order.id,
        JSON.stringify({ ...input, createdAt: nowISO() }),
      );
      audit(req, 'cancelled investigation', 'investigation', order.id);
      notifyPatient(db, order.patientId, `investigation-cancelled:${order.id}`, {
        kind: 'investigation',
        title: 'An investigation request was cancelled',
        detail: order.title,
        href: '/my-care/record?tab=workflows',
      });
    });
    res.json(investigationView(order));
  });
  app.post('/api/encounters/:id/amendments', (req: AuthRequest, res) => {
    const identity = doctorIdentity(req),
      encounterId = String(req.params.id);
    const encounter = get<Encounter>(db, 'encounters', encounterId);
    if (!encounter) return fail(404, 'Consultation record not found.');
    patientAccess(req, encounter.patientId);
    const input = z.object({ reason: text.min(1), text: text.min(1) }).parse(req.body);
    const amendment: EncounterAmendment = {
      ...input,
      ...identity,
      id: id(),
      encounterId,
      patientId: encounter.patientId,
      createdAt: nowISO(),
    };
    transaction(() => {
      db.prepare(
        'INSERT INTO encounterAmendments(id,patientId,encounterId,data) VALUES (?,?,?,?)',
      ).run(amendment.id, amendment.patientId, encounterId, JSON.stringify(amendment));
      audit(req, 'added consultation amendment', 'encounter', encounterId);
    });
    res.status(201).json(amendment);
  });
  app.post('/api/procedures', (req: AuthRequest, res) => {
    const identity = doctorIdentity(req);
    const input = z
      .object({
        patientId: required,
        appointmentId: required.nullable().optional(),
        title: required,
        indication: text.min(1),
        benefits: text.min(1),
        risks: text.min(1),
        alternatives: text.min(1),
        aftercare: text.min(1),
        estimatedCost: z.string().trim().max(300).default(''),
      })
      .parse(req.body);
    patientAccess(req, input.patientId);
    const plan: ProcedurePlan = {
      ...input,
      ...identity,
      id: id(),
      appointmentId: input.appointmentId ?? null,
      status: 'planned',
      cancellationReason: null,
      createdAt: nowISO(),
    };
    transaction(() => {
      if (plan.appointmentId) {
        const appointment = get<Appointment>(db, 'appointments', plan.appointmentId);
        if (!appointment || appointment.patientId !== plan.patientId)
          fail(400, 'The linked appointment must belong to this patient.');
        if (['cancelled', 'no-show'].includes(appointment!.status))
          fail(409, 'Choose an appointment that has not been cancelled or marked as a no-show.');
      }
      insert(db, 'procedures', plan);
      audit(req, 'planned procedure and documented discussion information', 'procedure', plan.id);
      notifyPatient(db, plan.patientId, `procedure-planned:${plan.id}`, {
        kind: 'procedure',
        title: 'A procedure plan is ready to discuss',
        detail: plan.title,
        href: '/my-care/record?tab=workflows',
      });
    });
    res.status(201).json(procedureView(plan));
  });
  app.post('/api/procedures/:id/agreements', (req: AuthRequest, res) => {
    const user = actor(req),
      plan = procedureAccess(req, String(req.params.id));
    const input = z
      .object({
        decision: z.enum(['agreed', 'declined']),
        method: z.enum(['portal', 'in-person', 'phone']),
        note: text.default(''),
        patientDecisionConfirmed: z.boolean().optional(),
      })
      .parse(req.body);
    if (user.role === 'patient') {
      if (input.method !== 'portal')
        fail(403, 'Patients must record their own decision through the portal.');
    } else {
      doctorIdentity(req);
      if (input.method === 'portal')
        fail(403, 'A portal acknowledgement must be submitted by the patient.');
      if (!input.patientDecisionConfirmed || !input.note)
        fail(
          400,
          'Confirm the patient decision and record a discussion note for an in-person or phone agreement.',
        );
    }
    transaction(() => {
      requirePlannedProcedure(plan);
      const agreement: ProcedureAgreement = {
        id: id(),
        procedureId: plan.id,
        decision: input.decision,
        method: input.method,
        note: input.note,
        recordedById: user.id,
        recordedByName: user.name,
        recordedByRole: user.role,
        createdAt: nowISO(),
      };
      db.prepare('INSERT INTO procedureAgreements(id,procedureId,data) VALUES (?,?,?)').run(
        agreement.id,
        plan.id,
        JSON.stringify(agreement),
      );
      audit(req, `recorded procedure decision: ${agreement.decision}`, 'procedure', plan.id);
      if (user.role === 'patient')
        notifyClinicians(
          db,
          plan.patientId,
          `procedure-decision:${agreement.id}`,
          {
            kind: 'procedure',
            title: 'A patient recorded a procedure decision',
            detail: `${user.name} · ${plan.title}`,
            href: `/clinic/patients/${plan.patientId}?tab=workup`,
          },
          { doctorId: plan.doctorId, excludeActorId: user.id },
        );
      else
        notifyPatient(db, plan.patientId, `procedure-decision:${agreement.id}`, {
          kind: 'procedure',
          title: 'Your procedure discussion was recorded',
          detail: plan.title,
          href: '/my-care/record?tab=workflows',
        });
    });
    res.status(201).json(procedureView(plan));
  });
  app.post('/api/procedures/:id/complete', (req: AuthRequest, res) => {
    const identity = doctorIdentity(req),
      plan = procedureAccess(req, String(req.params.id));
    const input = z.object({ outcome: text.min(1), aftercare: text.min(1) }).parse(req.body);
    transaction(() => {
      requirePlannedProcedure(plan);
      const latest = events<ProcedureAgreement>('procedureAgreements', 'procedureId', plan.id).at(
        -1,
      );
      if (!latest || latest.decision !== 'agreed')
        fail(
          409,
          'Record the patient agreement before completing this procedure. The latest recorded decision must be agreed.',
        );
      if (plan.appointmentId) {
        const appointment = get<Appointment>(db, 'appointments', plan.appointmentId)!;
        if (['cancelled', 'no-show'].includes(appointment.status))
          fail(
            409,
            'The linked appointment is cancelled or marked as a no-show. Plan the procedure again against the correct appointment.',
          );
        if (Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) > Date.now())
          fail(
            409,
            'The linked appointment is in the future. Complete the procedure after the visit starts.',
          );
      }
      const completion: ProcedureCompletion = { ...input, ...identity, completedAt: nowISO() };
      db.prepare('INSERT INTO procedureCompletions(id,data) VALUES (?,?)').run(
        plan.id,
        JSON.stringify(completion),
      );
      audit(req, 'completed procedure and recorded aftercare', 'procedure', plan.id);
      notifyPatient(db, plan.patientId, `procedure-completed:${plan.id}`, {
        kind: 'procedure',
        title: 'Your procedure aftercare is available',
        detail: plan.title,
        href: '/my-care/record?tab=workflows',
      });
    });
    res.json(procedureView(plan));
  });
  app.post('/api/procedures/:id/cancel', (req: AuthRequest, res) => {
    doctorIdentity(req);
    const plan = procedureAccess(req, String(req.params.id));
    const input = z.object({ reason: text.min(1) }).parse(req.body);
    transaction(() => {
      requirePlannedProcedure(plan);
      db.prepare('INSERT INTO procedureCancellations(id,data) VALUES (?,?)').run(
        plan.id,
        JSON.stringify({ ...input, createdAt: nowISO() }),
      );
      audit(req, 'cancelled procedure', 'procedure', plan.id);
      notifyPatient(db, plan.patientId, `procedure-cancelled:${plan.id}`, {
        kind: 'procedure',
        title: 'A procedure plan was cancelled',
        detail: plan.title,
        href: '/my-care/record?tab=workflows',
      });
    });
    res.json(procedureView(plan));
  });
}

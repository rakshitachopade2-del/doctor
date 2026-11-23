import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { registerProcedureCompletion } from './procedure-completion.ts';
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
import type {
  InvestigationResultCommand,
  InvestigationResultResponse,
  InvestigationResultNotSubmitted,
} from '../shared/investigation-result-submission.ts';
import type {
  ProcedureDecisionCommand,
  ProcedureDecisionNotRecorded,
  ProcedureDecisionResponse,
} from '../shared/procedure-decision.ts';
import { clinicToday, get, id, insert, list, nowISO, type DB } from './db.ts';
import { notifyPatient, notifyClinicians } from './activity.ts';
import {
  investigationRequestId,
  investigationRevision,
  registerInvestigationWorklist,
} from './investigation-worklist.ts';
import {
  effectiveProcedureAppointment,
  registerProcedureScheduling,
} from './procedure-scheduling.ts';
import {
  procedureCatalogueRequestId,
  procedureTemplateSelection,
  registerProcedureCatalogue,
} from './procedure-catalogue.ts';

interface ClinicalContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  clinicianId: (req: AuthRequest) => string;
  currentCareUser: (req: AuthRequest) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type InvestigationOrder = Omit<Investigation, 'results' | 'reviews'>;
type ProcedurePlan = Omit<
  ProcedureRecord,
  'agreements' | 'completion' | 'effectiveAppointmentId' | 'scheduledAppointment'
>;
const required = z.string().trim().min(1).max(300);
const text = z.string().trim().max(8000);
const cancelledInvestigation =
  'This investigation is cancelled. Create a new order if further testing is needed.';
const resultFields = z.object({ note: text, documentIds: z.array(required).max(10) });
const validateResult = (input: z.infer<typeof resultFields>, ctx: z.RefinementCtx) => {
  if (!input.note && !input.documentIds.length)
    ctx.addIssue({ code: 'custom', message: 'Add a result note or at least one report.' });
  if (new Set(input.documentIds).size !== input.documentIds.length)
    ctx.addIssue({ code: 'custom', message: 'Do not link the same report more than once.' });
};
const legacyResult = resultFields
  .extend({
    note: text.default(''),
    documentIds: resultFields.shape.documentIds.default([]),
  })
  .superRefine(validateResult);
const resultCommand = resultFields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    patientId: required,
    investigationId: required,
    submittedByRole: z.enum(['patient', 'doctor', 'admin']),
    reviewedConfirmed: z.literal(true),
  })
  .strict()
  .superRefine(validateResult);
const noQuery = z.object({}).strict();
const closedProcedure =
  'This procedure is already completed or cancelled. Its documentation cannot be changed.';
const decisionFields = z.object({
  decision: z.enum(['agreed', 'declined']),
  method: z.enum(['portal', 'in-person', 'phone']),
  note: text,
  patientDecisionConfirmed: z.boolean(),
});
const legacyDecision = decisionFields.extend({
  note: text.default(''),
  patientDecisionConfirmed: z.boolean().optional(),
});
const decisionCommand = decisionFields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    patientId: required,
    procedureId: required,
    recordedByRole: z.enum(['patient', 'doctor', 'admin']),
    expectedLatestDecisionId: required.nullable(),
    reviewedConfirmed: z.literal(true),
  })
  .strict();
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
    CREATE TABLE IF NOT EXISTS investigationResultCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      investigationId TEXT NOT NULL REFERENCES investigations(id), commandHash TEXT NOT NULL,
      resultId TEXT UNIQUE REFERENCES investigationResults(id), rejectionStatus INTEGER, rejection TEXT,
      CHECK ((resultId IS NOT NULL AND rejectionStatus IS NULL AND rejection IS NULL)
          OR (resultId IS NULL AND rejectionStatus IS NOT NULL AND rejectionStatus IN (400,409) AND rejection IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS investigationReviews (id TEXT PRIMARY KEY, investigationId TEXT NOT NULL REFERENCES investigations(id), resultId TEXT NOT NULL REFERENCES investigationResults(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigationPublications (id TEXT PRIMARY KEY REFERENCES investigationReviews(id), publishedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigationCancellations (id TEXT PRIMARY KEY REFERENCES investigations(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS encounterAmendments (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), encounterId TEXT NOT NULL REFERENCES encounters(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedures (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedureAgreements (id TEXT PRIMARY KEY, procedureId TEXT NOT NULL REFERENCES procedures(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedureDecisionCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      procedureId TEXT NOT NULL REFERENCES procedures(id), commandHash TEXT NOT NULL,
      agreementId TEXT UNIQUE REFERENCES procedureAgreements(id), rejection TEXT,
      CHECK ((agreementId IS NOT NULL AND rejection IS NULL) OR (agreementId IS NULL AND rejection IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS procedureCompletions (id TEXT PRIMARY KEY REFERENCES procedures(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS procedureCancellations (id TEXT PRIMARY KEY REFERENCES procedures(id), data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS investigation_results_order ON investigationResults(investigationId);
    CREATE INDEX IF NOT EXISTS investigation_reviews_order ON investigationReviews(investigationId);
    CREATE INDEX IF NOT EXISTS procedure_agreements_order ON procedureAgreements(procedureId);
  `);
  for (const table of [
    'investigations',
    'investigationResults',
    'investigationResultCommands',
    'investigationReviews',
    'investigationPublications',
    'investigationCancellations',
    'encounterAmendments',
    'procedures',
    'procedureAgreements',
    'procedureDecisionCommands',
    'procedureCompletions',
    'procedureCancellations',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Clinical documentation is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Clinical documentation is append-only'); END;`);
  }
  registerProcedureScheduling(app, { db, actor, audit, fail });
  const procedureCatalogue = registerProcedureCatalogue(app, { db, actor, audit, fail });
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
  const investigationWorklist = registerInvestigationWorklist(app, {
    db,
    actor,
    patientAccess,
    audit,
    fail,
    view: (investigationId) => {
      const order = get<InvestigationOrder>(db, 'investigations', investigationId);
      if (!order) return fail(404, 'Investigation not found.');
      return investigationView(order);
    },
  });
  function procedureView(plan: ProcedurePlan): ProcedureRecord {
    const agreements = events<ProcedureAgreement>('procedureAgreements', 'procedureId', plan.id);
    const completion = get<ProcedureCompletion>(db, 'procedureCompletions', plan.id) ?? null;
    const cancellation = get<{ reason: string }>(db, 'procedureCancellations', plan.id);
    return {
      ...plan,
      ...effectiveProcedureAppointment(db, plan),
      status: completion ? 'completed' : cancellation ? 'cancelled' : 'planned',
      cancellationReason: cancellation?.reason ?? null,
      agreements,
      completion,
    };
  }
  function requireOpenInvestigation(order: InvestigationOrder) {
    if (get(db, 'investigationCancellations', order.id)) fail(409, cancelledInvestigation);
  }
  function requirePlannedProcedure(plan: ProcedurePlan) {
    if (procedureView(plan).status !== 'planned') fail(409, closedProcedure);
  }
  function workflows(patientId: string, forPatient: boolean): PatientClinicalWorkflows {
    return {
      investigations: list<InvestigationOrder>(db, 'investigations', patientId).map((order) =>
        investigationView(order, forPatient),
      ),
      procedures: list<ProcedurePlan>(db, 'procedures', patientId).map(procedureView),
      amendments: forPatient ? [] : list<EncounterAmendment>(db, 'encounterAmendments', patientId),
    };
  }
  app.get('/api/patients/:id/clinical-workflows', (req: AuthRequest, res) => {
    const patientId = String(req.params.id),
      user = actor(req);
    patientAccess(req, patientId);
    const data = workflows(patientId, user.role === 'patient');
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
  function resultContext(req: AuthRequest) {
    const user = context.currentCareUser(req);
    if (user.role !== 'patient') clinicianId(req);
    const order = investigationAccess(req, String(req.params.id));
    return { user, order };
  }
  function resultDenied(order: InvestigationOrder, documentIds: string[]) {
    if (get(db, 'investigationCancellations', order.id))
      return { status: 409, message: cancelledInvestigation };
    const owned = db.prepare('SELECT 1 FROM documents WHERE patientId=? AND id=?');
    if (documentIds.some((doc) => !owned.get(order.patientId, doc)))
      return { status: 400, message: 'Every linked report must belong to this patient.' };
    return null;
  }
  function appendResult(
    req: AuthRequest,
    user: User,
    order: InvestigationOrder,
    input: z.infer<typeof resultFields>,
  ) {
    const result: InvestigationResult = {
      id: id(),
      investigationId: order.id,
      note: input.note,
      documentIds: input.documentIds,
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
        href: `/clinic/patients/${order.patientId}?tab=workup&investigation=${order.id}&result=${result.id}`,
      },
      { doctorId: investigationWorklist.ownerDoctorId(order.id), excludeActorId: user.id },
    );
    return result;
  }
  app.post('/api/investigations/:id/results', (req: AuthRequest, res) => {
    const view = transaction(() => {
      const { user, order } = resultContext(req);
      const input = legacyResult.parse(req.body);
      const denied = resultDenied(order, input.documentIds);
      if (denied) return fail(denied.status, denied.message);
      appendResult(req, user, order, input);
      return investigationView(order, user.role === 'patient');
    });
    res.status(201).json(view);
  });
  app.post('/api/investigations/:id/results/submit', (req: AuthRequest, res) => {
    const outcome = transaction(() => {
      const { user, order } = resultContext(req);
      noQuery.parse(req.query);
      const command: InvestigationResultCommand = resultCommand.parse(req.body);
      const { requestId, submittedByRole, investigationId, patientId } = command,
        actorId = user.id;
      if (submittedByRole !== user.role)
        return fail(403, 'The reviewed submitting role does not match this account.');
      if (investigationId !== order.id || patientId !== order.patientId)
        return fail(409, 'The reviewed investigation and patient must match this record.');
      // The parsed command has a stable key order, while report order remains part of the submission.
      const commandHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const success = (result: InvestigationResult): InvestigationResultResponse => ({
        receipt: { requestId, actorId, patientId, investigationId, result },
      });
      const rejected = (message: string): InvestigationResultNotSubmitted => ({
        code: 'INVESTIGATION_RESULT_NOT_SUBMITTED',
        actorId,
        command,
        message,
      });
      const prior = db
        .prepare(
          'SELECT c.*, r.data AS originalResult FROM investigationResultCommands c LEFT JOIN investigationResults r ON r.id=c.resultId WHERE c.requestId=?',
        )
        .get(requestId);
      if (prior) {
        if (
          prior.actorId !== actorId ||
          prior.investigationId !== investigationId ||
          prior.commandHash !== commandHash
        )
          return fail(409, 'This request ID was already used for another result submission.');
        if (typeof prior.rejection === 'string')
          return { status: Number(prior.rejectionStatus), body: rejected(prior.rejection) };
        return { status: 200, body: success(JSON.parse(String(prior.originalResult))) };
      }
      const store = db.prepare(
        'INSERT INTO investigationResultCommands(requestId, actorId, investigationId, commandHash, resultId, rejectionStatus, rejection) VALUES (?,?,?,?,?,?,?)',
      );
      const denied = resultDenied(order, command.documentIds);
      if (denied) {
        store.run(
          requestId,
          actorId,
          investigationId,
          commandHash,
          null,
          denied.status,
          denied.message,
        );
        return { status: denied.status, body: rejected(denied.message) };
      }
      const result = appendResult(req, user, order, command);
      store.run(requestId, actorId, investigationId, commandHash, result.id, null, null);
      return { status: 201, body: success(result) };
    });
    res.status(outcome.status).json(outcome.body);
  });
  app.post('/api/investigations/:id/reviews', (req: AuthRequest, res) => {
    const identity = doctorIdentity(req),
      order = investigationAccess(req, String(req.params.id)),
      user = actor(req);
    const { expectedRevision, requestId, ...input } = z
      .object({
        resultId: required,
        summary: text.min(1),
        followUp: text.default(''),
        publishToPatient: z.boolean().default(false),
        expectedRevision: investigationRevision.optional(),
        requestId: investigationRequestId.optional(),
      })
      .refine(
        (value) => (value.expectedRevision === undefined) === (value.requestId === undefined),
        'Provide both the current investigation revision and request ID, or omit both for legacy requests.',
      )
      .parse(req.body);
    let duplicate = false;
    transaction(() => {
      if (
        requestId &&
        investigationWorklist.commandReplay(user, 'review', order.id, requestId, input)
      ) {
        duplicate = true;
        return;
      }
      requireOpenInvestigation(order);
      if (expectedRevision) investigationWorklist.assertRevision(order.id, expectedRevision);
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
      if (requestId)
        investigationWorklist.rememberCommand(
          user,
          'review',
          order.id,
          requestId,
          input,
          review.id,
        );
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
    res.status(duplicate ? 200 : 201).json(investigationView(order));
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
        requireOpenInvestigation(order);
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
  app.post('/api/procedures', (req: AuthRequest, res) => {
    z.object({}).strict().parse(req.query);
    const input = z
      .object({
        patientId: required,
        appointmentId: required.nullable().default(null),
        title: required,
        indication: text.min(1),
        benefits: text.min(1),
        risks: text.min(1),
        alternatives: text.min(1),
        aftercare: text.min(1),
        estimatedCost: z.string().trim().max(300).default(''),
        requestId: procedureCatalogueRequestId.optional(),
        templateSelection: procedureTemplateSelection.optional(),
        reviewedForPatient: z.literal(true).optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.templateSelection
            ? !!value.requestId && value.reviewedForPatient === true
            : value.reviewedForPatient === undefined,
        'Template use requires a request ID and explicit patient-specific review. The review acknowledgment applies only to a selected template.',
      )
      .parse(req.body);
    const result = transaction(() => {
      const { user, doctor } = procedureCatalogue.authorize(req, true);
      patientAccess(req, input.patientId);
      const prior = procedureCatalogue.replayPlan(user, input);
      if (prior)
        return {
          procedure: procedureView(get<ProcedurePlan>(db, 'procedures', prior.procedureId)!),
          receipt: prior,
          replayed: true,
        };
      const {
        requestId: _requestId,
        templateSelection,
        reviewedForPatient: _reviewed,
        ...fields
      } = input;
      const templateSource = procedureCatalogue.resolveSelection(templateSelection, fields);
      const plan: ProcedurePlan = {
        ...fields,
        doctorId: doctor!.id,
        doctorName: doctor!.name,
        id: id(),
        status: 'planned',
        cancellationReason: null,
        createdAt: nowISO(),
        ...(templateSource ? { templateSource } : {}),
      };
      if (plan.appointmentId) {
        const appointment = get<Appointment>(db, 'appointments', plan.appointmentId);
        if (!appointment || appointment.patientId !== plan.patientId)
          fail(400, 'The linked appointment must belong to this patient.');
        if (['cancelled', 'no-show'].includes(appointment!.status))
          fail(409, 'Choose an appointment that has not been cancelled or marked as a no-show.');
      }
      insert(db, 'procedures', plan);
      const receipt = procedureCatalogue.recordPlan(user, input, plan);
      audit(req, 'planned procedure and documented discussion information', 'procedure', plan.id);
      notifyPatient(db, plan.patientId, `procedure-planned:${plan.id}`, {
        kind: 'procedure',
        title: 'A procedure plan is ready to discuss',
        detail: plan.title,
        href: '/my-care/record?tab=workflows',
      });
      return { procedure: procedureView(plan), receipt, replayed: false };
    });
    res
      .status(result.replayed ? 200 : 201)
      .json(
        result.receipt
          ? { procedure: result.procedure, receipt: result.receipt }
          : result.procedure,
      );
  });
  function decisionContext(req: AuthRequest) {
    const user = context.currentCareUser(req);
    const plan = procedureAccess(req, String(req.params.id));
    return { user, plan };
  }
  function validateDecisionMethod(
    req: AuthRequest,
    user: User,
    input: z.infer<typeof legacyDecision>,
  ) {
    if (user.role === 'patient') {
      if (input.method !== 'portal')
        fail(403, 'Patients must record their own decision through the portal.');
    } else {
      clinicianId(req);
      if (input.method === 'portal')
        fail(403, 'A portal acknowledgement must be submitted by the patient.');
      if (!input.patientDecisionConfirmed || !input.note)
        fail(
          400,
          'Confirm the patient decision and record a discussion note for an in-person or phone agreement.',
        );
    }
  }
  function appendDecision(
    req: AuthRequest,
    user: User,
    plan: ProcedurePlan,
    input: z.infer<typeof legacyDecision>,
  ) {
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
    return agreement;
  }
  app.post('/api/procedures/:id/agreements', (req: AuthRequest, res) => {
    const view = transaction(() => {
      const { user, plan } = decisionContext(req);
      const input = legacyDecision.parse(req.body);
      validateDecisionMethod(req, user, input);
      requirePlannedProcedure(plan);
      appendDecision(req, user, plan, input);
      return procedureView(plan);
    });
    res.status(201).json(view);
  });
  app.post('/api/procedures/:id/agreements/record', (req: AuthRequest, res) => {
    const outcome = transaction(() => {
      const { user, plan } = decisionContext(req);
      noQuery.parse(req.query);
      const command: ProcedureDecisionCommand = decisionCommand.parse(req.body);
      const { requestId, procedureId, patientId, recordedByRole, expectedLatestDecisionId } =
        command;
      const actorId = user.id;
      if (recordedByRole !== user.role)
        return fail(403, 'The reviewed recording role does not match this account.');
      if (procedureId !== plan.id || patientId !== plan.patientId)
        return fail(409, 'The reviewed procedure and patient must match this record.');
      validateDecisionMethod(req, user, command);
      if (user.role === 'patient' && command.patientDecisionConfirmed)
        return fail(
          400,
          'Only staff documenting a discussion can attest to a communicated decision.',
        );

      const commandHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const success = (agreement: ProcedureAgreement): ProcedureDecisionResponse => ({
        receipt: {
          requestId,
          actorId,
          patientId,
          procedureId,
          expectedLatestDecisionId,
          agreement,
        },
      });
      const rejected = (message: string): ProcedureDecisionNotRecorded => ({
        code: 'PROCEDURE_DECISION_NOT_RECORDED',
        actorId,
        command,
        message,
      });
      const prior = db
        .prepare(
          'SELECT c.*, a.data AS originalAgreement FROM procedureDecisionCommands c LEFT JOIN procedureAgreements a ON a.id=c.agreementId WHERE c.requestId=?',
        )
        .get(requestId);
      if (prior) {
        if (
          prior.actorId !== actorId ||
          prior.procedureId !== procedureId ||
          prior.commandHash !== commandHash
        )
          return fail(409, 'This request ID was already used for another procedure decision.');
        if (typeof prior.rejection === 'string')
          return { status: 409, body: rejected(prior.rejection) };
        return { status: 200, body: success(JSON.parse(String(prior.originalAgreement))) };
      }
      const current = procedureView(plan);
      const latestId = current.agreements.at(-1)?.id ?? null;
      const rejection =
        current.status !== 'planned'
          ? closedProcedure
          : latestId !== expectedLatestDecisionId
            ? 'The latest procedure decision has changed. Review the current decision before recording another.'
            : null;
      const store = db.prepare(
        'INSERT INTO procedureDecisionCommands(requestId,actorId,procedureId,commandHash,agreementId,rejection) VALUES (?,?,?,?,?,?)',
      );
      if (rejection) {
        store.run(requestId, actorId, procedureId, commandHash, null, rejection);
        return { status: 409, body: rejected(rejection) };
      }
      const agreement = appendDecision(req, user, plan, command);
      store.run(requestId, actorId, procedureId, commandHash, agreement.id, null);
      return { status: 201, body: success(agreement) };
    });
    res.status(outcome.status).json(outcome.body);
  });
  registerProcedureCompletion(app, {
    db,
    transaction,
    audit,
    fail,
    authorize(req) {
      const user = context.currentCareUser(req);
      const identity = doctorIdentity(req);
      const procedure = procedureView(procedureAccess(req, String(req.params.id)));
      return { user, ...identity, procedure };
    },
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
  return { patientView: (patientId: string) => workflows(patientId, true) };
}

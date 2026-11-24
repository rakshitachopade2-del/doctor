import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Investigation, InvestigationReview } from '../shared/clinical.ts';
import {
  investigationReviewCommand,
  reviewFields,
  type InvestigationReviewCommand,
  type InvestigationReviewReceipt,
  type InvestigationReviewNotRecorded,
} from '../shared/investigation-review-recording.ts';
import type { User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';
import { cancelledInvestigation } from './investigation-cancellation.ts';
import {
  investigationRevision,
  investigationRequestId,
  type registerInvestigationWorklist,
} from './investigation-worklist.ts';

type Order = Omit<Investigation, 'results' | 'reviews'>;
interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorize: (req: AuthRequest) => {
    user: User;
    order: Order;
    doctorId: string;
    doctorName: string;
  };
  view: (order: Order) => Investigation;
  worklist: ReturnType<typeof registerInvestigationWorklist>;
  audit: (req: AuthRequest, action: string, type: string, id: string) => void;
  fail: (status: number, message: string) => never;
}
const legacy = reviewFields
  .extend({
    followUp: reviewFields.shape.followUp.default(''),
    publishToPatient: reviewFields.shape.publishToPatient.default(false),
    expectedRevision: investigationRevision.optional(),
    requestId: investigationRequestId.optional(),
  })
  .refine(
    (value) => (value.expectedRevision === undefined) === (value.requestId === undefined),
    'Provide both the current investigation revision and request ID, or omit both for legacy requests.',
  );
const stale =
  'The investigation, results, reviews or responsibility changed. Refresh and review the latest context before saving.';
function requireWrite(n: number | bigint) {
  if (Number(n) !== 1) throw new Error('The investigation review could not be recorded.');
}
export function registerInvestigationReviews(
  app: Express,
  { db, transaction, authorize, view, worklist, audit, fail }: Dependencies,
) {
  function audited(req: AuthRequest, action: string, type: string, id: string) {
    audit(req, action, type, id);
    requireWrite(Number(db.prepare('SELECT changes() AS n').get()!.n));
  }
  function publish(req: AuthRequest, order: Order, reviewId: string) {
    requireWrite(
      db
        .prepare('INSERT INTO investigationPublications(id,publishedAt) VALUES (?,?)')
        .run(reviewId, nowISO()).changes,
    );
    audited(req, 'published investigation review to patient', 'investigationReview', reviewId);
    if (
      !notifyPatient(db, order.patientId, 'investigation-review:' + reviewId, {
        kind: 'investigation',
        title: 'Your clinician shared a report review',
        detail: order.title,
        href: '/my-care/record?tab=workflows',
      })
    )
      throw new Error('The review publication notice could not be recorded.');
  }
  app.post('/api/investigations/:id/reviews', (req: AuthRequest, res) => {
    const saved = transaction(() => {
      const { order, user, doctorId, doctorName } = authorize(req);
      const body = req.body;
      const checked =
        body && typeof body === 'object' && Object.hasOwn(body, 'reviewedByRole')
          ? investigationReviewCommand.parse(body)
          : null;
      if (checked) {
        z.strictObject({}).parse(req.query);
        if (checked.doctorId !== doctorId || checked.reviewedByRole !== user.role)
          return fail(403, 'The reviewed clinician and role must match the current account.');
        if (checked.investigationId !== order.id || checked.patientId !== order.patientId)
          return fail(409, 'The reviewed patient and investigation must match this record.');
      }
      const parsed = checked ?? legacy.parse(body),
        { expectedRevision, requestId } = parsed,
        input = reviewFields.parse(parsed);
      const evidence = checked ?? input;
      const digest = checked
        ? createHash('sha256').update(JSON.stringify(checked)).digest('hex')
        : null;
      function refusal(
        command: InvestigationReviewCommand,
        message: string,
      ): InvestigationReviewNotRecorded {
        return { code: 'INVESTIGATION_REVIEW_NOT_RECORDED', actorId: user.id, command, message };
      }
      if (checked) {
        const prior = db
          .prepare(
            'SELECT actorId,investigationId,commandHash,message FROM investigationReviewRefusals WHERE requestId=?',
          )
          .get(checked.requestId);
        if (prior) {
          if (
            prior.actorId !== user.id ||
            prior.investigationId !== order.id ||
            prior.commandHash !== digest
          )
            return fail(409, 'This investigation request was already used with different details.');
          return { status: 409, body: refusal(checked, String(prior.message)) };
        }
      }
      const eventId =
        requestId && worklist.commandReplay(user, 'review', order.id, requestId, evidence);
      function confirmed(reviewId: string, status: number) {
        const investigation = view(order);
        if (!checked) return { status, body: investigation };
        const review = investigation.reviews.find((r) => r.id === reviewId);
        if (!review) throw new Error('The original investigation review is unavailable.');
        const receipt: InvestigationReviewReceipt = {
          requestId: checked.requestId,
          actorId: user.id,
          patientId: order.patientId,
          investigationId: order.id,
          expectedRevision: checked.expectedRevision,
          reviewedByRole: checked.reviewedByRole,
          review: { ...review, publishedAt: checked.publishToPatient ? review.publishedAt : null },
        };
        return { status, body: { ...investigation, receipt } };
      }
      if (eventId) return confirmed(eventId, 200);
      const source = worklist.reviewContext(order.id);
      const denial =
        source.status === 'cancelled'
          ? cancelledInvestigation
          : expectedRevision && expectedRevision !== source.revision
            ? stale
            : source.latestResultId !== input.resultId
              ? 'Review the latest submitted result. A newer report may have arrived; refresh the record.'
              : null;
      if (denial) {
        if (!checked) return fail(409, denial);
        requireWrite(
          db
            .prepare(
              'INSERT INTO investigationReviewRefusals(requestId,actorId,investigationId,commandHash,message) VALUES(?,?,?,?,?)',
            )
            .run(checked.requestId, user.id, order.id, digest, denial).changes,
        );
        return { status: 409, body: refusal(checked, denial) };
      }
      const review: InvestigationReview = {
        id: id(),
        investigationId: order.id,
        resultId: input.resultId,
        summary: input.summary,
        followUp: input.followUp,
        doctorId,
        doctorName,
        publishedAt: null,
        createdAt: nowISO(),
      };
      requireWrite(
        db
          .prepare(
            'INSERT INTO investigationReviews(id,investigationId,resultId,data) VALUES (?,?,?,?)',
          )
          .run(review.id, order.id, review.resultId, JSON.stringify(review)).changes,
      );
      if (requestId)
        worklist.rememberCommand(user, 'review', order.id, requestId, evidence, review.id);
      if (input.publishToPatient) publish(req, order, review.id);
      audited(req, 'reviewed investigation result', 'investigation', order.id);
      return confirmed(review.id, 201);
    });
    res.status(saved.status).json(saved.body);
  });
  app.post('/api/investigations/:id/reviews/:reviewId/publish', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const { order } = authorize(req),
        investigation = view(order),
        review = investigation.reviews.find((r) => r.id === String(req.params.reviewId));
      if (!review) return fail(404, 'Review not found for this investigation.');
      if (review.publishedAt) return investigation;
      if (investigation.status === 'cancelled') return fail(409, cancelledInvestigation);
      publish(req, order, review.id);
      return view(order);
    });
    res.json(result);
  });
}

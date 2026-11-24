import { createHash } from 'node:crypto';
import type { Express, Response } from 'express';
import { z } from 'zod';
import {
  staffAccountFields,
  staffInitialPassword,
  type StaffAccountCreationResponse,
  type StaffAccountCreationReview,
  type StaffAccountNotCreated,
} from '../shared/staff-account-creation.ts';
import type { User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { createUser, id, type DB } from './db.ts';
import { accountLinkageProblem } from './identity.ts';

interface Dependencies {
  db: DB;
  currentSessionUser: (req: AuthRequest) => User;
  transaction: <T>(operation: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const legacy = staffAccountFields.extend({
  doctorId: staffAccountFields.shape.doctorId.unwrap().optional(),
  password: staffInitialPassword,
});
const reviewInput = staffAccountFields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    reviewedConfirmed: z.literal(true),
  })
  .strict();
const creationInput = reviewInput.extend({ password: staffInitialPassword });
const noQuery = z.object({}).strict();
type Fields = Pick<StaffAccountCreationReview, 'name' | 'email' | 'role'> & {
  doctorId?: string | null;
};

export function registerStaffAccountCreation(
  app: Express,
  { db, currentSessionUser, transaction, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS staffAccountCreationCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id), reviewHash TEXT NOT NULL,
    accountId TEXT UNIQUE REFERENCES users(id), originalAccount TEXT, refusal TEXT,
    CHECK ((accountId IS NOT NULL AND originalAccount IS NOT NULL AND refusal IS NULL) OR
           (accountId IS NULL AND originalAccount IS NULL AND refusal IS NOT NULL))
  );
  CREATE TRIGGER IF NOT EXISTS staffAccountCreationCommands_no_update BEFORE UPDATE ON staffAccountCreationCommands
    BEGIN SELECT RAISE(ABORT,'Staff account creation evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS staffAccountCreationCommands_no_delete BEFORE DELETE ON staffAccountCreationCommands
    BEGIN SELECT RAISE(ABORT,'Staff account creation evidence is immutable'); END;`);
  function administrator(req: AuthRequest) {
    const user = currentSessionUser(req);
    if (user.mustChangePassword)
      return fail(403, 'Change your temporary password before accessing your workspace.');
    if (user.role !== 'admin')
      return fail(403, 'Your account does not have permission for this action.');
    return user;
  }
  function problem(input: Fields) {
    const linkage = accountLinkageProblem(db, {
      role: input.role,
      doctorId: input.doctorId ?? undefined,
    });
    if (linkage) return linkage;
    if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(input.email))
      return { status: 409, message: 'An account already exists with this email.' };
    return null;
  }
  function create(req: AuthRequest, input: Fields, password: string) {
    const account: User = {
      id: id(),
      name: input.name,
      email: input.email,
      role: input.role,
      active: true,
      mustChangePassword: true,
      ...(input.doctorId ? { doctorId: input.doctorId } : {}),
    };
    createUser(db, account, password);
    audit(req, 'created staff account', 'user', account.id);
    return account;
  }
  app.post('/api/users', (req: AuthRequest, res) => {
    const account = transaction(() => {
      administrator(req);
      const input = legacy.parse(req.body);
      const rejection = problem(input);
      if (rejection) return fail(rejection.status, rejection.message);
      return create(req, input, input.password);
    });
    res.status(201).json(account);
  });

  function handle(req: AuthRequest, res: Response, operation: 'create' | 'resolve') {
    const result = transaction(() => {
      const actor = administrator(req);
      noQuery.parse(req.query);
      const { password, ...review } =
        operation === 'create'
          ? creationInput.parse(req.body)
          : { ...reviewInput.parse(req.body), password: undefined };
      // Recovery is bound only to the reviewed account details. The user's sign-in
      // verifier is the only persistent value derived from the initial password.
      const reviewHash = createHash('sha256').update(JSON.stringify(review)).digest('hex');
      const { requestId } = review;
      const prior = db
        .prepare(
          'SELECT actorId,reviewHash,originalAccount,refusal FROM staffAccountCreationCommands WHERE requestId=?',
        )
        .get(requestId);
      const success = (account: User): StaffAccountCreationResponse => ({
        receipt: { actorId: actor.id, requestId, account },
      });
      const refused = (message: string): StaffAccountNotCreated => ({
        code: 'STAFF_ACCOUNT_NOT_CREATED',
        actorId: actor.id,
        review,
        message,
      });
      if (prior) {
        if (prior.actorId !== actor.id || prior.reviewHash !== reviewHash)
          return fail(409, 'This request ID was already used for another staff account creation.');
        if (typeof prior.refusal === 'string') return { status: 409, body: refused(prior.refusal) };
        return { status: 200, body: success(JSON.parse(String(prior.originalAccount))) };
      }
      const store = db.prepare(
        'INSERT INTO staffAccountCreationCommands(requestId,actorId,reviewHash,accountId,originalAccount,refusal) VALUES (?,?,?,?,?,?)',
      );
      function storeRefusal(message: string) {
        store.run(requestId, actor.id, reviewHash, null, null, message);
        return { status: 409, body: refused(message) };
      }
      if (password === undefined)
        return storeRefusal(
          'This request was closed before an account was created. Review the details and enter a new initial password to try again.',
        );
      const rejection = problem(review);
      if (rejection) return storeRefusal(rejection.message);
      const account = create(req, review, password);
      store.run(requestId, actor.id, reviewHash, account.id, JSON.stringify(account), null);
      return { status: 201, body: success(account) };
    });
    res.status(result.status).json(result.body);
  }
  app.post('/api/users/create', (req: AuthRequest, res) => handle(req, res, 'create'));
  app.post('/api/users/creation-outcome', (req: AuthRequest, res) => handle(req, res, 'resolve'));
}

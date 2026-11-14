import { existsSync } from 'node:fs';
import { z } from 'zod';
import { openDatabase } from './db.ts';
import { initializeIdentity } from './identity.ts';
import { initializeMfa, resetMfaForOperator } from './mfa.ts';

// This local operator command deliberately works without a lost encryption key.
// It removes factors only after an operator has separately verified account identity.
async function main() {
  const path = process.env.DATABASE_PATH;
  if (!path || path === ':memory:' || !existsSync(path))
    throw new Error('DATABASE_PATH must identify an existing clinic database.');
  if (process.env.MFA_RESET_IDENTITY_VERIFIED !== 'true')
    throw new Error('Set MFA_RESET_IDENTITY_VERIFIED=true only after verifying the account owner.');
  const email = z.string().email().parse(process.env.MFA_RESET_EMAIL).toLowerCase();
  let reason = process.env.MFA_RESET_REASON;
  if (!reason) {
    if (process.stdin.isTTY)
      throw new Error('Provide the reset reason through stdin or MFA_RESET_REASON.');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 2000) throw new Error('The reset reason is too long.');
    }
    reason = input;
  }
  reason = z.string().trim().min(1).max(1000).parse(reason);
  const db = openDatabase(path);
  try {
    initializeIdentity(db);
    initializeMfa(db, null, false);
    db.exec('BEGIN IMMEDIATE');
    try {
      const user = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
      if (!user) throw new Error('Account not found.');
      resetMfaForOperator(db, String(user.id), reason);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(
      'MFA reset recorded. All sessions and outstanding recovery grants were revoked. The account must change its password at the next sign-in.',
    );
  } finally {
    db.close();
  }
}
try {
  await main();
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? 'Provide a valid account email and a reset reason of 1–1000 characters.'
      : error instanceof Error
        ? error.message
        : 'MFA reset failed.',
  );
  process.exitCode = 1;
}

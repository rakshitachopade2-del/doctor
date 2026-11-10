import { z } from 'zod';
import { openDatabase, createUser, id } from './db.ts';

// Keep bootstrap secrets out of command-line history: provide ADMIN_PASSWORD via stdin.
const email = z.string().email().parse(process.env.ADMIN_EMAIL).toLowerCase();
const name = z
  .string()
  .min(1)
  .max(300)
  .parse(process.env.ADMIN_NAME || 'Clinic administrator');
if (process.stdin.isTTY) {
  console.error(
    'Pipe the administrator password through stdin. Set ADMIN_EMAIL and optional ADMIN_NAME / DATABASE_PATH.',
  );
  process.exit(1);
}
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 256) throw new Error('Password input is too long.');
}
const password = z
  .string()
  .min(12)
  .max(128)
  .parse(input.replace(/\r?\n$/, ''));
const db = openDatabase();
try {
  if (db.prepare('SELECT 1 FROM meta WHERE key=?').get('demo-seeded'))
    throw new Error('Use a fresh non-demo database for administrator bootstrap.');
  if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(email))
    throw new Error('This email already has an account.');
  createUser(db, { id: id(), name, email, role: 'admin' }, password);
  console.log(
    'Administrator created. Sign in and configure the clinic, doctor profiles and staff accounts.',
  );
} finally {
  db.close();
}

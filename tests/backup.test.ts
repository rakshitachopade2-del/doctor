import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from '../server/backup.ts';

test('online backups include committed WAL data and are independently readable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-backup-'));
  const source = join(directory, 'clinic.sqlite');
  const destination = join(directory, 'backups', 'snapshot.sqlite');
  const writer = new DatabaseSync(source);
  try {
    writer.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
    );
    writer.prepare('INSERT INTO records(body) VALUES (?)').run('Committed before backup');
    assert.ok(statSync(`${source}-wal`).size > 0);
    const result = await backupDatabase(source, destination);
    assert.ok(result.pages > 0);
    assert.equal(result.destination, destination);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(
        snapshot.prepare('SELECT body FROM records').get()!.body,
        'Committed before backup',
      );
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      writer.prepare('INSERT INTO records(body) VALUES (?)').run('Written after snapshot');
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM records').get()!.n, 1);
      assert.equal(writer.prepare('SELECT count(*) AS n FROM records').get()!.n, 2);
    } finally {
      snapshot.close();
    }
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(join(directory, 'backups')).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup refuses existing paths, missing sources and leaves no partial artifact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-backup-errors-'));
  const source = join(directory, 'clinic.sqlite');
  const destination = join(directory, 'existing.sqlite');
  const database = new DatabaseSync(source);
  database.exec('CREATE TABLE example(id INTEGER)');
  database.close();
  try {
    writeFileSync(destination, 'Do not overwrite');
    await assert.rejects(backupDatabase(source, destination), /already exists/);
    assert.equal(readFileSync(destination, 'utf8'), 'Do not overwrite');
    await assert.rejects(backupDatabase(source, source), /already exists/);
    await assert.rejects(
      backupDatabase(join(directory, 'missing.sqlite'), join(directory, 'new.sqlite')),
      /does not exist/,
    );
    writeFileSync(join(directory, 'not-a-database.sqlite'), 'Not a SQLite database');
    await assert.rejects(
      backupDatabase(join(directory, 'not-a-database.sqlite'), join(directory, 'failed.sqlite')),
    );
    assert.ok(
      !readdirSync(directory).some((name) => name.endsWith('.tmp') || name === 'failed.sqlite'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import { backup, DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

/** Online, consistent SQLite snapshot; existing destinations are never overwritten. */
export async function backupDatabase(sourcePath: string, destinationPath: string) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error('Source database does not exist or is not a regular file.');
  }
  if (existsSync(destination))
    throw new Error('Backup destination already exists. Choose a new path.');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  // The private temporary file is in the destination directory so atomic link creation
  // can publish a finished snapshot without overwriting any pre-existing destination.
  closeSync(openSync(temporary, 'wx', 0o600));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    const pages = await backup(db, temporary, { rate: 100 });
    linkSync(temporary, destination);
    return { destination, pages };
  } finally {
    db?.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

const isCLI = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCLI) {
  const destination = process.argv[2];
  if (!destination || process.argv.length > 3) {
    console.error('Usage: npm run backup -- /private/backup/location/clinic-YYYY-MM-DD.sqlite');
    process.exitCode = 1;
  } else {
    try {
      const result = await backupDatabase(
        process.env.DATABASE_PATH || 'data/clinic.sqlite',
        destination,
      );
      console.log(`Backup created: ${result.destination} (${result.pages} pages)`);
    } catch (error) {
      console.error(`Backup failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

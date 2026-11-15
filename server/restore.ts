import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreDatabaseBackup, verifyDatabaseBackup } from './database-recovery.ts';

const isCLI = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCLI) {
  const args = process.argv.slice(2);
  try {
    let result;
    if (args.length === 2 && args[0] === 'verify') result = await verifyDatabaseBackup(args[1]);
    else if (args.length === 5 && args[0] === 'restore' && args[3] === '--reason')
      result = await restoreDatabaseBackup(args[1], args[2], { reason: args[4] });
    else
      throw new Error(
        'Usage: recovery verify SOURCE | recovery restore SOURCE NEWDEST --reason TEXT',
      );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Recovery failed: ${error instanceof Error ? error.message : 'The operation could not be completed.'}\n`,
    );
    process.exitCode = 1;
  }
}

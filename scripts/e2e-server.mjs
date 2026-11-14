import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'derma-browser-'));
const apiPort = process.env.E2E_API_PORT || '3011';
const vitePort = process.env.E2E_VITE_PORT || '5183';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  FOLLOW_UP_ESCALATION_AUTO: 'false',
  DATABASE_PATH: join(directory, 'clinic.sqlite'),
  PORT: apiPort,
  API_PORT: apiPort,
  VITE_PORT: vitePort,
};
const commands = [
  ['--import', 'tsx', 'server/index.ts'],
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'],
];
const children = commands.map((args) => spawn(process.execPath, args, { env, stdio: 'inherit' }));
let stopping = false;
let closed = 0;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children)
  child.on('exit', (code) => {
    closed++;
    if (!stopping) stop();
    if (closed === children.length) {
      rmSync(directory, { recursive: true, force: true });
      process.exit(code || 0);
    }
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

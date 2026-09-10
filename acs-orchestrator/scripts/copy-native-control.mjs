import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'remote');
const destination = join(root, 'dist', 'remote');
const required = [
  'runner_daemon.py', 'attempt_supervisor.py', 'attempt_control.py', 'process_control.py', 'signed_receipts.py',
  'dws_control.py', 'dws_receive_stream.py', 'dws_receiver.py', 'dws_receiver_state.py', 'dws_spool.py',
];
const files = readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.py') && !entry.name.startsWith('test_') && !entry.name.endsWith('_test.py'))
  .map((entry) => entry.name).sort();
for (const name of required) {
  if (!files.includes(name)) throw new Error(`Missing native control entry: ${name}`);
}
// This directory is build output only. Never run a cleanup against a workspace.
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true, mode: 0o755 });
const inventory = [];
for (const name of files) {
  const input = join(source, name);
  const output = join(destination, name);
  const bytes = readFileSync(input);
  copyFileSync(input, output);
  chmodSync(output, 0o444);
  inventory.push({ path: `remote/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
writeFileSync(join(root, 'dist', 'native-control-manifest.json'), `${JSON.stringify({ protocolVersion: 1, files: inventory }, null, 2)}\n`, { mode: 0o444 });
console.log(`Packaged ${inventory.length} immutable native control files`);

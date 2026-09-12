import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function rig(t, readerSource) {
  const dir = mkdtempSync(join(tmpdir(), 'production-preflight-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of [
    'production-preflight.mjs',
    'production-runtime-observation.mjs',
    'production-preflight-report.mjs',
  ]) {
    copyFileSync(resolve('scripts/release', name), join(dir, name));
  }
  // The child is a protocol fixture, not a claim of a real production health observation.
  writeFileSync(join(dir, 'read-production-state.mjs'), readerSource);
  const output = join(dir, 'state.json');
  const diagnostics = join(dir, 'report.json');
  const result = spawnSync(
    process.execPath,
    [
      join(dir, 'production-preflight.mjs'),
      '--reader',
      'read-production-state.mjs',
      '--config-identity-stage',
      'steady-state',
      '--output',
      output,
      '--diagnostics',
      diagnostics,
      '--run-id',
      '123',
      '--run-attempt',
      '2',
      '--retry-mode',
      'fresh',
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  return { result, output, diagnostics };
}

test('actual CLI transports the stage and accepts only a complete successful child output', (t) => {
  const f = rig(
    t,
    `import { writeFileSync } from 'node:fs';
const options = Object.fromEntries(Array.from({length: (process.argv.length - 2) / 2}, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
if (options['--config-identity-stage'] !== 'steady-state') throw new Error('stage missing');
writeFileSync(options['--output'], JSON.stringify({ environment: 'production', components: { protocolFixture: true } }), { flag: 'wx' });
console.log('PRIVATE_CHILD_STDOUT_DO_NOT_FORWARD');
`,
  );
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(JSON.parse(readFileSync(f.output, 'utf8')).components.protocolFixture, true);
  assert.equal(JSON.parse(readFileSync(f.diagnostics, 'utf8')).status, 'passed');
  assert.doesNotMatch(f.result.stdout, /PRIVATE_CHILD_STDOUT/u);
});

test('actual failed reader saves a diagnostic report without forwarding private exception text', (t) => {
  const f = rig(
    t,
    `throw new Error('Unable to read production readyfile for runtimeWorker. SECRET_TOKEN=never-forward');`,
  );
  assert.equal(f.result.status, 1, f.result.stderr);
  assert.equal(existsSync(f.output), false);
  const report = readFileSync(f.diagnostics, 'utf8');
  assert.equal(JSON.parse(report).status, 'failed');
  assert.equal(JSON.parse(report).attempts[0].exitCode, 1);
  assert.doesNotMatch(report + f.result.stdout + f.result.stderr, /SECRET_TOKEN|never-forward/u);
});

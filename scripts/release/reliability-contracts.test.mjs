import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertEngineCompatibility } from './deployment-engine.mjs';
import { safeAssetEvent, collectDiagnostics } from './collect-promotion-diagnostics.mjs';
import { validateProductionOperation } from './production-operation.mjs';

test('T12: execution engine accepts reviewed historical manifest versions, rejects unknown versions', () => {
  for (const schemaVersion of [1, 2])
    assert.doesNotThrow(() => assertEngineCompatibility({ schemaVersion }));
  for (const schemaVersion of [undefined, 0, 3, '2'])
    assert.throws(() => assertEngineCompatibility({ schemaVersion }));
});

test('T15: checkpoint-only repair has explicit release/reason authorization, no standby authorization', () => {
  const inputs = {
    operation: 'checkpoint-repair',
    release_id: 'rc-20260911-01',
    reason: 'Repair derived checkpoint only',
  };
  const context = { eventName: 'workflow_dispatch', ref: 'refs/heads/main' };
  assert.deepEqual(validateProductionOperation(inputs, context), {
    operation: 'checkpoint-repair',
    recoveryMode: '',
  });
  for (const overrides of [
    { release_id: '' },
    { reason: '' },
    { confirm_recovery_only: true },
    { expected_plan_digest: 'sha256:' + 'a'.repeat(64) },
  ])
    assert.throws(() => validateProductionOperation({ ...inputs, ...overrides }, context));
});

test('T16: diagnostics retain safe stage timing and drop arbitrary keys, user text and credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'promotion-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web-asset-diagnostics'));
  const event = {
    key: 'chunk-abc.js',
    phase: 'readback',
    attempt: 2,
    exitCode: 124,
    durationSeconds: 60,
    token: 'SECRET',
    stdout: 'USER DATA',
  };
  await writeFile(join(root, 'web-asset-diagnostics/worker-1.jsonl'), JSON.stringify(event) + '\n');
  assert.equal(safeAssetEvent({ ...event, key: 'invalid?token=secret' }), null);
  const report = await collectDiagnostics(root, join(root, 'out'));
  assert.equal(report.webAssets.events.length, 1);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
  assert.equal(JSON.stringify(report).includes('USER DATA'), false);
  assert.equal(report.webAssets.events[0].exitCode, 124);
});

test('T09: actual publication shell repairs missing objects before an immutable index commit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-set-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['src', 'remote', 'bin']) await mkdir(join(root, dir));
  for (const file of ['artifact-index.json', 'a.tgz', 'b.tgz'])
    await writeFile(join(root, 'src', file), file);
  await writeFile(join(root, 'remote/artifact-index.json'), 'artifact-index.json');
  await writeFile(join(root, 'bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(
    join(root, 'publish-artifact-set.sh'),
    await readFile(new URL('./publish-artifact-set.sh', import.meta.url)),
  );
  await writeFile(
    join(root, 'upload-oss-object-immutable.sh'),
    `#!/bin/bash
set -eu
name="$(basename "$2")"
echo "$name" >> "$TEST_ROOT/order"
if [ -e "$TEST_ROOT/remote/$name" ]; then cmp "$1" "$TEST_ROOT/remote/$name"; else cp "$1" "$TEST_ROOT/remote/$name"; fi
`,
  );
  const run = () =>
    spawnSync(
      'bash',
      [join(root, 'publish-artifact-set.sh'), join(root, 'src'), 'oss://bucket/rc', 'a'.repeat(40)],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, TEST_ROOT: root },
      },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    (await readFile(join(root, 'order'), 'utf8')).trim(),
    'a.tgz\nb.tgz\nartifact-index.json',
  );
  assert.equal(await readFile(join(root, 'remote/b.tgz'), 'utf8'), 'b.tgz');
  await writeFile(join(root, 'remote/a.tgz'), 'conflict');
  const second = run();
  assert.notEqual(second.status, 0);
});

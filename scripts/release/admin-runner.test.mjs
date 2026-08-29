import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ADMIN_RUNNER_ENTRIES,
  MANIFEST_KIND,
  adminEntryFile,
  adminRunnerManifest,
  esbuildArgs,
} from '../../server/scripts/build-admin-runner.mjs';
import { assertAdminRunnerShipped } from './build-release.mjs';

test('admin runner entries reference real one-off operations scripts', async () => {
  const serverRoot = join(process.cwd(), 'server');
  for (const entry of ADMIN_RUNNER_ENTRIES) {
    await stat(join(serverRoot, entry.source));
    assert.match(entry.command, /^[a-z0-9-]+$/u);
    assert.ok(entry.description.length > 0);
  }
  const commands = ADMIN_RUNNER_ENTRIES.map((entry) => entry.command);
  assert.equal(new Set(commands).size, commands.length);
});

test('admin runner bundles keep runtime packages external like dist/index.js', () => {
  const args = esbuildArgs('scripts/migrate-events-file-to-pg.mts', 'dist/admin/out.mjs');
  assert.ok(args.includes('--bundle'));
  assert.ok(args.includes('--platform=node'));
  assert.ok(args.includes('--format=esm'));
  assert.ok(args.includes('--target=node22'));
  assert.ok(args.includes('--packages=external'));
  assert.ok(args.includes('--sourcemap'));
  assert.ok(args.some((item) => item.startsWith('--outfile=')));
});

test('admin runner manifest stays deterministic and self-describing', () => {
  const commands = ADMIN_RUNNER_ENTRIES.map((entry) => ({
    command: entry.command,
    entry: adminEntryFile(entry.command),
    source: entry.source,
    description: entry.description,
    digest: `sha256:${'a'.repeat(64)}`,
    size: 1,
  }));
  const first = adminRunnerManifest(MANIFEST_KIND, commands);
  const second = adminRunnerManifest(MANIFEST_KIND, commands);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.kind, MANIFEST_KIND);
  assert.equal(first.commands.length, ADMIN_RUNNER_ENTRIES.length);
});

function realDigest(body) {
  return {
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    size: Buffer.byteLength(body),
  };
}

async function stageAdminRunner(root, { mutate } = {}) {
  const serverRoot = join(root, 'server');
  await mkdir(join(serverRoot, 'dist', 'admin'), { recursive: true });
  const commands = ADMIN_RUNNER_ENTRIES.map((entry) => {
    const body = `/* ${entry.command} */`;
    return {
      command: entry.command,
      entry: adminEntryFile(entry.command),
      source: entry.source,
      description: entry.description,
      ...realDigest(body),
    };
  });
  const staged = mutate ? mutate(commands) : commands;
  for (const command of staged) {
    const sourcePath = join(serverRoot, command.source);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// source\n');
    await writeFile(join(serverRoot, 'dist', 'admin', command.entry), `/* ${command.command} */`);
  }
  await writeFile(
    join(serverRoot, 'dist', 'admin', 'manifest.json'),
    `${JSON.stringify(adminRunnerManifest(MANIFEST_KIND, staged), null, 2)}\n`,
  );
  return serverRoot;
}

test('release fails closed when the admin runner did not ship', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-runner-missing-'));
  try {
    await assert.rejects(assertAdminRunnerShipped(root), /Admin Runner manifest missing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release accepts a complete admin runner manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-runner-ok-'));
  try {
    await stageAdminRunner(root);
    const verified = await assertAdminRunnerShipped(root);
    assert.equal(verified.kind, MANIFEST_KIND);
    assert.equal(verified.commands.length, ADMIN_RUNNER_ENTRIES.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release rejects admin runner command drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-runner-drift-'));
  try {
    await stageAdminRunner(root, {
      mutate: (commands) => commands.slice(0, commands.length - 1),
    });
    await assert.rejects(assertAdminRunnerShipped(root), /command set drifted/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release rejects admin runner entries that no longer match the manifest digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-runner-tamper-'));
  try {
    await stageAdminRunner(root, {
      mutate: (commands) =>
        commands.map((command, index) =>
          index === 0 ? { ...command, digest: `sha256:${'0'.repeat(64)}` } : command,
        ),
    });
    await assert.rejects(assertAdminRunnerShipped(root), /does not match its manifest digest/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

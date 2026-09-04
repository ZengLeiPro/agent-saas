import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { access, link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = 'scripts/release/seal-root-staged-payload.sh';
chmodSync(SCRIPT, 0o755);

async function fixture(label) {
  const root = await mkdtemp(join(tmpdir(), `staged-payload-${label}-`));
  const destination = join(root, 'run-1');
  const source = join(root, 'source');
  const archive = join(destination, 'payload.tgz');
  await mkdir(destination, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'payload.txt'), label);
  const tar = spawnSync('tar', ['-C', source, '-czf', archive, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  return { root, destination, archive, digest };
}

function seal(value, mode, digest = value.digest) {
  return spawnSync('bash', [SCRIPT, mode, digest, value.archive, value.destination], {
    encoding: 'utf8',
    env: { ...process.env, STAGED_PAYLOAD_ALLOWED_ROOT: value.root },
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('verifies runner-pinned bytes without removing the staged archive', async () => {
  const value = await fixture('verify');
  const result = seal(value, 'verify');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await exists(value.archive), true);
});

test('extracts verified bytes and removes the transport archive', async () => {
  const value = await fixture('extract');
  const result = seal(value, 'extract');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(value.destination, 'payload.txt'), 'utf8'), 'extract');
  assert.equal(await exists(value.archive), false);
});

test('rejects tampered bytes and clears the dedicated root-only staging directory', async () => {
  const value = await fixture('tamper');
  await writeFile(value.archive, 'tampered');
  const result = seal(value, 'extract');
  assert.notEqual(result.status, 0);
  assert.equal(await exists(value.destination), false);
});

test('rejects archive links before extraction and clears staging', async () => {
  const value = await fixture('link');
  const source = join(value.root, 'link-source');
  await mkdir(source);
  await symlink('/etc/passwd', join(source, 'payload.txt'));
  const tar = spawnSync('tar', ['-C', source, '-czf', value.archive, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  value.digest = createHash('sha256').update(readFileSync(value.archive)).digest('hex');
  const result = seal(value, 'verify');
  assert.notEqual(result.status, 0);
  assert.equal(await exists(value.destination), false);
});

test('rejects archive hard links before extraction and clears staging', async () => {
  const value = await fixture('hard-link');
  const source = join(value.root, 'hard-link-source');
  await mkdir(source);
  await writeFile(join(source, 'first.txt'), 'same inode');
  await link(join(source, 'first.txt'), join(source, 'second.txt'));
  const tar = spawnSync('tar', ['-C', source, '-czf', value.archive, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  value.digest = createHash('sha256').update(readFileSync(value.archive)).digest('hex');
  const result = seal(value, 'extract');
  assert.notEqual(result.status, 0);
  assert.equal(await exists(value.destination), false);
});

test('rejects staging destinations outside the controlled root', async () => {
  const value = await fixture('escape');
  const outside = await mkdtemp(join(tmpdir(), 'staged-payload-outside-'));
  const result = spawnSync('bash', [SCRIPT, 'verify', value.digest, value.archive, outside], {
    encoding: 'utf8',
    env: { ...process.env, STAGED_PAYLOAD_ALLOWED_ROOT: value.root },
  });
  assert.notEqual(result.status, 0);
});

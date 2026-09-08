import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertPublishedDisk, authorityDirectory, atomicWrite, isOwnerAlive, processIdentity,
  preparePublicationAuthority, publicationEventCount, publishedExpected, rawRevision,
  readPublication, readSnapshot, saveSnapshot, signingAvailable, writePublication,
} from './config-publication.mjs';

const IDENTITY = { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` };
const NEXT = { schemaVersion: 1, digest: `sha256:${'b'.repeat(64)}` };
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'config-authority-'));
  const path = join(root, 'config.json');
  writeFileSync(path, '{"models":{"default":"main/old"}}\n');
  try { return fn({ root, path }); } finally { rmSync(root, { recursive: true, force: true }); }
}
function intent(path) {
  const previous = readPublication(path);
  const text = '{"models":{"default":"main/new"}}\n';
  saveSnapshot(path, text);
  return { ...previous, revision: randomUUID(), sequence: previous.sequence + 1,
    phase: 'applying', rawRevision: rawRevision(text), identity: NEXT,
    previous: { revision: previous.revision, rawRevision: previous.rawRevision, identity: previous.identity },
    owner: processIdentity(), actor: 'platform-admin', changedPaths: ['models'] };
}

test('legacy absence does not initialize or accept a new authority', () => fixture(({ path }) => {
  assert.equal(readPublication(path), undefined);
  assert.equal(signingAvailable(path), false);
  assert.deepEqual(publishedExpected(path, 'rc-1', IDENTITY), IDENTITY);
}));

test('controlled initialization is durable, private and does not change config bytes', () => fixture(({ path }) => {
  const before = readFileSync(path, 'utf8');
  const state = preparePublicationAuthority(path, 'rc-1', IDENTITY);
  assert.deepEqual(readPublication(path), state);
  assert.equal(state.phase, 'committed');
  assert.equal(signingAvailable(path), true);
  assert.equal(readSnapshot(path, state.rawRevision), before);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(publicationEventCount(path), 1);
  assert.deepEqual(preparePublicationAuthority(path, 'rc-2', NEXT), state);
}));

test('authorized commit survives fresh reads while immutable release fallback is retained', () => fixture(({ path }) => {
  preparePublicationAuthority(path, 'rc-1', IDENTITY);
  const next = intent(path);
  writePublication(path, next);
  atomicWrite(path, readSnapshot(path, next.rawRevision));
  assert.throws(() => publishedExpected(path, 'rc-1', IDENTITY), /recovery/u);
  assert.deepEqual(publishedExpected(path, 'rc-1', IDENTITY, false), NEXT);
  const committed = writePublication(path, { ...next, phase: 'committed', sequence: next.sequence + 1 });
  assert.deepEqual(publishedExpected(path, 'rc-1', IDENTITY), NEXT);
  assert.deepEqual(publishedExpected(path, 'rc-2', IDENTITY), IDENTITY);
  assert.deepEqual(readPublication(path), committed);
  assert.equal(publicationEventCount(path), 3);
}));

test('a plain file edit is rejected by runtime AND deployment readers', () => fixture(({ path }) => {
  preparePublicationAuthority(path, 'rc-1', IDENTITY);
  writeFileSync(path, 'unauthorized');
  assert.throws(() => assertPublishedDisk(path), /Unpublished/u);
  assert.throws(() => publishedExpected(path, 'rc-1', IDENTITY), /Unpublished/u);
  assert.throws(() => preparePublicationAuthority(path, 'rc-2', NEXT), /Unpublished/u);
}));

test('tampering with a signed head is never silently adopted', () => fixture(({ path }) => {
  preparePublicationAuthority(path, 'rc-1', IDENTITY);
  const current = join(authorityDirectory(path), 'current.json');
  const envelope = JSON.parse(readFileSync(current, 'utf8'));
  envelope.record.identity = NEXT;
  writeFileSync(current, JSON.stringify(envelope));
  assert.throws(() => readPublication(path), /signature/u);
}));

test('pending and recovery_required transactions block code deployment', () => fixture(({ path }) => {
  preparePublicationAuthority(path, 'rc-1', IDENTITY);
  const next = intent(path);
  atomicWrite(path, readSnapshot(path, next.rawRevision));
  for (const phase of ['applying', 'rolling_back', 'recovery_required']) {
    writePublication(path, { ...next, phase });
    assert.throws(() => preparePublicationAuthority(path, 'rc-2', NEXT), /pending/u);
  }
}));

test('interruption before file replacement retains the old recovery snapshot', () => fixture(({ path }) => {
  const previous = preparePublicationAuthority(path, 'rc-1', IDENTITY);
  const next = intent(path);
  writePublication(path, next);
  assert.throws(() => assertPublishedDisk(path), /Unpublished/u);
  assert.equal(rawRevision(readSnapshot(path, next.previous.rawRevision)), previous.rawRevision);
  assert.equal(readPublication(path).phase, 'applying');
}));

test('snapshots enforce content integrity and reject traversal', () => fixture(({ path }) => {
  const state = preparePublicationAuthority(path, 'rc-1', IDENTITY);
  assert.throws(() => readSnapshot(path, '../private.pem'), /Invalid/u);
  writeFileSync(join(authorityDirectory(path), 'snapshots', `${state.rawRevision}.jsonc`), 'tampered');
  assert.throws(() => readSnapshot(path, state.rawRevision), /integrity/u);
}));

test('unsafe authority permissions and symlink replacement fail closed', () => fixture(({ root, path }) => {
  preparePublicationAuthority(path, 'rc-1', IDENTITY);
  const authority = authorityDirectory(path);
  chmodSync(authority, 0o755);
  assert.throws(() => readPublication(path), /permissions/u);
  chmodSync(authority, 0o700);
  const head = join(authority, 'current.json');
  const target = join(root, 'fake.json');
  writeFileSync(target, readFileSync(head));
  rmSync(head);
  symlinkSync(target, head);
  assert.throws(() => readPublication(path), /symlinks/u);
}));

test('owner identity binds PID, OS boot and process start time', () => {
  const owner = processIdentity();
  assert.equal(isOwnerAlive(owner), true);
  assert.equal(isOwnerAlive({ ...owner, startTicks: `${owner.startTicks}0` }), false);
  assert.equal(isOwnerAlive({ ...owner, bootId: randomUUID() }), false);
});

test('different environment directories never share keys or configuration state', () => fixture(({ root, path }) => {
  const other = join(root, 'other-config.json');
  // The authority is deliberately per environment directory, not per config filename.
  const isolated = mkdtempSync(join(tmpdir(), 'isolated-config-'));
  try {
    const isolatedPath = join(isolated, 'config.json');
    writeFileSync(isolatedPath, '{}');
    preparePublicationAuthority(path, 'rc-1', IDENTITY);
    assert.equal(readPublication(isolatedPath), undefined);
    assert.equal(signingAvailable(isolatedPath), false);
    assert.notEqual(authorityDirectory(path), authorityDirectory(isolatedPath));
    assert.equal(authorityDirectory(path), authorityDirectory(other));
  } finally { rmSync(isolated, { recursive: true, force: true }); }
}));

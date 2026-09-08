#!/usr/bin/env node
/**
 * Single-host production configuration authority. Deployment owns the signing
 * directory; runtime never bootstraps a key or adopts an unsigned disk edit.
 * The root-owned API/deployer are trusted (as in the existing systemd units).
 * This signature is not a defence against a compromised host root account.
 */
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomUUID, sign, verify,
} from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOMAIN = 'agent-saas-production-model-publication-v1\0';
const HEX = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PHASES = new Set(['committed', 'applying', 'rolling_back', 'recovery_required']);

export function rawRevision(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function authorityDirectory(configPath) {
  return join(dirname(resolve(configPath)), 'config-publications');
}

function assertPrivate(path, directory = false) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) {
    throw new Error('Configuration authority must not contain symlinks or special files');
  }
  if ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) {
    throw new Error('Configuration authority has unsafe owner or permissions');
  }
}

export function atomicWrite(path, text, mode = 0o600) {
  const parent = dirname(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function processIdentity(pid = process.pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm may contain spaces and parentheses; field 22 is starttime.
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^[0-9]+$/u.test(startTicks ?? '')) throw new Error('Process start time is unavailable');
  return { pid, startTicks, bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}

export function isOwnerAlive(owner) {
  try { return canonical(processIdentity(owner.pid)) === canonical(owner); }
  catch { return false; }
}

function identity(value) {
  if (!value || value.schemaVersion !== 1 || !DIGEST.test(value.digest ?? '')
    || (value.credentialVersionDigest !== undefined && !DIGEST.test(value.credentialVersionDigest))) {
    throw new Error('Invalid published ConfigIdentity');
  }
  return {
    schemaVersion: 1, digest: value.digest,
    ...(value.credentialVersionDigest ? { credentialVersionDigest: value.credentialVersionDigest } : {}),
  };
}

function version(value) {
  if (!value || typeof value.revision !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/u.test(value.revision)
    || !HEX.test(value.rawRevision ?? '')) throw new Error('Invalid configuration version');
  return { revision: value.revision, rawRevision: value.rawRevision, identity: identity(value.identity) };
}

export function validatePublication(value) {
  if (!value || value.schemaVersion !== 1 || value.environment !== 'production'
    || !PHASES.has(value.phase) || typeof value.releaseId !== 'string' || !value.releaseId.trim()
    || typeof value.actor !== 'string' || !value.actor.trim()
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !Array.isArray(value.changedPaths) || value.changedPaths.some((p) => typeof p !== 'string')
    || !Number.isFinite(Date.parse(value.updatedAt ?? ''))) throw new Error('Invalid configuration publication');
  const current = version(value);
  const previous = value.previous === undefined ? undefined : version(value.previous);
  if (value.phase !== 'committed' && (!previous || !value.owner
    || !Number.isSafeInteger(value.owner.pid) || value.owner.pid < 1
    || typeof value.owner.startTicks !== 'string' || typeof value.owner.bootId !== 'string')) {
    throw new Error('Incomplete configuration recovery journal');
  }
  return {
    schemaVersion: 1, environment: 'production', releaseId: value.releaseId,
    phase: value.phase, sequence: value.sequence, ...current,
    actor: value.actor, changedPaths: value.changedPaths, updatedAt: value.updatedAt,
    ...(previous ? { previous } : {}),
    ...(value.owner ? { owner: value.owner } : {}),
  };
}

function keyPaths(root) {
  assertPrivate(root, true);
  const publicPath = join(root, 'public.pem');
  assertPrivate(publicPath);
  return { publicPath, privatePath: join(root, 'private.pem') };
}

export function readPublication(configPath) {
  const root = authorityDirectory(configPath);
  if (!existsSync(root)) return undefined;
  const { publicPath } = keyPaths(root);
  const path = join(root, 'current.json');
  assertPrivate(path);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof envelope.signature !== 'string' || !envelope.record
    || !verify(null, Buffer.from(DOMAIN + canonical(envelope.record)),
      readFileSync(publicPath), Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Configuration publication signature verification failed');
  }
  return validatePublication(envelope.record);
}

export function signingAvailable(configPath) {
  try {
    const root = authorityDirectory(configPath);
    const { publicPath, privatePath } = keyPaths(root);
    assertPrivate(privatePath);
    return createPublicKey(createPrivateKey(readFileSync(privatePath))).export({ type: 'spki', format: 'pem' })
      === createPublicKey(readFileSync(publicPath)).export({ type: 'spki', format: 'pem' });
  } catch { return false; }
}

/** Caller MUST own the existing deployment/config.lock.guard OS fence. */
export function writePublication(configPath, input) {
  const record = validatePublication(input);
  const root = authorityDirectory(configPath);
  const { privatePath } = keyPaths(root);
  assertPrivate(privatePath);
  const signature = sign(null, Buffer.from(DOMAIN + canonical(record)), readFileSync(privatePath)).toString('base64');
  const text = `${JSON.stringify({ record, signature })}\n`;
  const events = join(root, 'events');
  assertPrivate(events, true);
  // Durable audit precedes authority. A crash can leave an unselected event, never
  // a selected head without the corresponding authenticated audit record.
  atomicWrite(join(events, `${record.sequence}-${record.phase}-${randomUUID()}.json`), text);
  atomicWrite(join(root, 'current.json'), text);
  return record;
}

export function saveSnapshot(configPath, text) {
  const root = authorityDirectory(configPath);
  assertPrivate(root, true);
  const snapshots = join(root, 'snapshots');
  assertPrivate(snapshots, true);
  const digest = rawRevision(text);
  const path = join(snapshots, `${digest}.jsonc`);
  if (existsSync(path)) {
    assertPrivate(path);
    if (readFileSync(path, 'utf8') !== text) throw new Error('Configuration snapshot collision');
  } else atomicWrite(path, text);
  return digest;
}

export function readSnapshot(configPath, digest) {
  if (!HEX.test(digest)) throw new Error('Invalid configuration snapshot revision');
  const path = join(authorityDirectory(configPath), 'snapshots', `${digest}.jsonc`);
  assertPrivate(path);
  const text = readFileSync(path, 'utf8');
  if (rawRevision(text) !== digest) throw new Error('Configuration snapshot integrity check failed');
  return text;
}

export function assertPublishedDisk(configPath, record = readPublication(configPath)) {
  if (record && rawRevision(readFileSync(configPath, 'utf8')) !== record.rawRevision) {
    throw new Error('Unpublished production configuration change detected');
  }
  return record;
}

/** Runtime and release tooling use this SAME selection rule. No observed->expected adoption. */
export function publishedExpected(configPath, releaseId, fallback, requireCommitted = true) {
  const record = assertPublishedDisk(configPath);
  if (!record) return fallback;
  if (requireCommitted && record.phase !== 'committed') throw new Error('Production configuration transaction requires recovery');
  // A new/rollback code release revalidates the signed disk snapshot with its own
  // parser and sealed release environment. It must not reuse another code version's digest.
  return record.releaseId === releaseId ? record.identity : fallback;
}

/** Deployment-only, under the config fence; never called by runtime or GET. */
export function preparePublicationAuthority(configPath, releaseId, expected) {
  identity(expected);
  const root = authorityDirectory(configPath);
  if (existsSync(root)) {
    const record = assertPublishedDisk(configPath);
    if (!record || record.phase !== 'committed') throw new Error('Resolve pending configuration transaction before deployment');
    if (!signingAvailable(configPath)) throw new Error('Configuration signing key is unavailable');
    return record;
  }
  const temporary = `${root}.init-${randomUUID()}`;
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const name of ['events', 'snapshots']) mkdirSync(join(temporary, name), { mode: 0o700 });
    const pair = generateKeyPairSync('ed25519');
    atomicWrite(join(temporary, 'private.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    atomicWrite(join(temporary, 'public.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const text = readFileSync(configPath, 'utf8');
    const digest = rawRevision(text);
    const record = validatePublication({
      schemaVersion: 1, environment: 'production', releaseId, phase: 'committed', sequence: 1,
      revision: randomUUID(), rawRevision: digest, identity: expected,
      actor: 'controlled-code-release', changedPaths: [], updatedAt: new Date().toISOString(),
    });
    const envelope = `${JSON.stringify({ record,
      signature: sign(null, Buffer.from(DOMAIN + canonical(record)), pair.privateKey).toString('base64'),
    })}\n`;
    atomicWrite(join(temporary, 'snapshots', `${digest}.jsonc`), text);
    atomicWrite(join(temporary, 'events', '1-release-baseline.json'), envelope);
    atomicWrite(join(temporary, 'current.json'), envelope);
    if (readFileSync(configPath, 'utf8') !== text) throw new Error('Configuration changed during authority preparation');
    renameSync(temporary, root);
    const parent = openSync(dirname(root), constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return record;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function publicationEventCount(configPath) {
  return readdirSync(join(authorityDirectory(configPath), 'events')).filter((name) => name.endsWith('.json')).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, configPath, releaseId, expected] = process.argv.slice(2);
  if (command === 'prepare' && configPath && releaseId && expected) {
    preparePublicationAuthority(configPath, releaseId, JSON.parse(expected));
  } else if (command === 'verify' && configPath) {
    const record = assertPublishedDisk(configPath);
    if (record && record.phase !== 'committed') throw new Error('Pending configuration publication');
  } else throw new Error('Usage: config-publication.mjs prepare <config> <release-id> <identity-json> | verify <config>');
}

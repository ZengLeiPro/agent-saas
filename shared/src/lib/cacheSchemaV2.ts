import type { AuthPrincipal, BoundaryIdentity } from './identity';

/** M30-02 canonical, cross-platform cache schema. Server state is never an input authority. */
export const CACHE_SCHEMA_VERSION = 2 as const;
export const CACHE_KEY_PREFIX = 'agent-cache:v2';
export const CACHE_MAX_KEY_LENGTH = 512;
export const CACHE_MAX_JSON_BYTES = 1_048_576;
export const CACHE_MAX_BACKUP_BYTES = CACHE_MAX_JSON_BYTES * 8;

const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const RESOURCE = /^[a-z][a-z0-9-]{0,47}$/u;
const FORBIDDEN_PROPERTY = /^(?:token|accessToken|refreshToken|credential|credentials|password|secret|savedPath|absolutePath|displayPath|rawTool|rawToolInput|rawToolResult|toolInput|toolResult|queue|queues|queueId|serverQueue|serverQueueId|runtime|cursor|epoch|interaction|interactions|attachmentId|uploadedAttachmentId|submissionId|serverSubmissionId)$/iu;
const POLLUTION_PROPERTY = /^(?:__proto__|prototype|constructor)$/u;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/|\\\\|file:\/\/)/u;
const OUTBOX_RESOURCES = new Set(['outbox-draft', 'draft-attachments']);
const OUTBOX_DRAFT_FIELDS = /^(?:draftId|localDraftId|localDraftRef|localDraftRefs|localUri)$/u; // values are opaque local-only references
const DISPLAY_RESOURCES = new Set(['sessions', 'messages', 'draft-metadata', 'draft-text', 'draft-attachments', 'outbox-draft']);

export class CacheSchemaError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'CacheSchemaError';
  }
}

export interface CacheOwner extends AuthPrincipal {}
export interface ParsedCacheKey extends CacheOwner { schemaVersion: 2; resource: string; resourceId: string }

function assertComponent(value: string, label: string, pattern = COMPONENT): void {
  if (typeof value !== 'string' || !pattern.test(value)) throw new CacheSchemaError('invalid_cache_key', `${label} has invalid characters or length`);
}

export const CacheKeyBuilder = Object.freeze({
  build(owner: CacheOwner, resource: string, resourceId: string): string {
    assertComponent(owner.tenantId, 'tenantId');
    assertComponent(owner.userId, 'userId');
    assertComponent(resource, 'resource', RESOURCE);
    assertComponent(resourceId, 'resourceId');
    const key = `${CACHE_KEY_PREFIX}:tenant=${owner.tenantId}:user=${owner.userId}:resource=${resource}:id=${resourceId}`;
    if (key.length > CACHE_MAX_KEY_LENGTH) throw new CacheSchemaError('invalid_cache_key', 'cache key is too long');
    return key;
  },
  parse(key: string): ParsedCacheKey {
    if (key.length > CACHE_MAX_KEY_LENGTH) throw new CacheSchemaError('invalid_cache_key');
    const match = /^agent-cache:v2:tenant=([^:]+):user=([^:]+):resource=([^:]+):id=([^:]+)$/u.exec(key);
    if (!match) throw new CacheSchemaError('invalid_cache_key');
    const [, tenantId, userId, resource, resourceId] = match;
    assertComponent(tenantId, 'tenantId');
    assertComponent(userId, 'userId');
    assertComponent(resource, 'resource', RESOURCE);
    assertComponent(resourceId, 'resourceId');
    return { schemaVersion: 2, tenantId, userId, resource, resourceId };
  },
});

export function cacheKeyForIdentity(identity: BoundaryIdentity | CacheOwner | null | undefined, resource: string, resourceId: string): string | null {
  return identity ? CacheKeyBuilder.build(identity, resource, resourceId) : null;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateTree(value: unknown, path: string, depth: number, backup: boolean): void {
  if (depth > 24) throw new CacheSchemaError('budget_exceeded', 'cache JSON nesting is too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new CacheSchemaError('invalid_json_value');
    return;
  }
  if (typeof value === 'string') {
    if (ABSOLUTE_PATH.test(value) && /(?:path|uri|url)$/iu.test(path)) throw new CacheSchemaError('absolute_path_forbidden', `${path} contains an absolute path`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) validateTree(value[index], `${path}[${index}]`, depth + 1, backup);
    return;
  }
  if (!value || typeof value !== 'object' || !isPlainObject(value)) throw new CacheSchemaError('invalid_json_value');
  for (const key of Object.keys(value)) {
    if (POLLUTION_PROPERTY.test(key)) throw new CacheSchemaError('prototype_pollution');
    if (backup && FORBIDDEN_PROPERTY.test(key)) throw new CacheSchemaError('forbidden_backup_field', `${path}.${key} is not display data`);
    validateTree((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, backup);
  }
}

/** Stable JSON: sorted object keys, no coercion, no prototypes and no path-bearing payloads. */
export function canonicalSerialize(value: unknown, maxBytes = CACHE_MAX_JSON_BYTES): string {
  validateTree(value, '$', 0, false);
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
  };
  const result = encode(value);
  if (new TextEncoder().encode(result).byteLength > maxBytes) throw new CacheSchemaError('budget_exceeded');
  return result;
}

export function parseCacheJson(raw: string, maxBytes = CACHE_MAX_JSON_BYTES): unknown {
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new CacheSchemaError('budget_exceeded');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new CacheSchemaError('corrupt_json'); }
  validateTree(parsed, '$', 0, false);
  return parsed;
}

/* Small synchronous SHA-256 plus code-unit ordering keeps Web, React Native and Node manifests byte-identical. */
export function cacheDigest(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) words[index >> 2] = (words[index >> 2] ?? 0) | bytes[index] << (24 - (index % 4) * 8);
  words[bytes.length >> 2] = (words[bytes.length >> 2] ?? 0) | 0x80 << (24 - (bytes.length % 4) * 8);
  words[(((bytes.length + 8) >> 6) + 1) * 16 - 1] = bytes.length * 8;
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (value: number, bits: number) => value >>> bits | value << (32 - bits);
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = new Array<number>(64);
    for (let i = 0; i < 64; i += 1) {
      if (i < 16) schedule[i] = words[offset + i] ?? 0;
      else {
        const a = schedule[i - 15]; const b = schedule[i - 2];
        schedule[i] = (schedule[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3) + schedule[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10)) | 0;
      }
    }
    const working = [...hash];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotate(working[4], 6) ^ rotate(working[4], 11) ^ rotate(working[4], 25);
      const choice = working[4] & working[5] ^ ~working[4] & working[6];
      const temp1 = (working[7] + s1 + choice + constants[i] + schedule[i]) | 0;
      const s0 = rotate(working[0], 2) ^ rotate(working[0], 13) ^ rotate(working[0], 22);
      const majority = working[0] & working[1] ^ working[0] & working[2] ^ working[1] & working[2];
      const temp2 = (s0 + majority) | 0;
      working[7]=working[6]; working[6]=working[5]; working[5]=working[4]; working[4]=(working[3]+temp1)|0;
      working[3]=working[2]; working[2]=working[1]; working[1]=working[0]; working[0]=(temp1+temp2)|0;
    }
    hash = hash.map((value, index) => (value + working[index]) | 0);
  }
  return `sha256:${hash.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('')}`;
}

export interface CacheEntryInput { resource: string; resourceId: string; type: string; data: unknown }
export interface CacheBackupEntry { key: string; type: string; payload: string }
export interface CacheManifestEntry { key: string; type: string; digest: string; bytes: number }
export interface CacheBackupManifest { schemaVersion: 2; owner: CacheOwner; exportedAt: string; entries: CacheManifestEntry[]; overallDigest: string }
export interface CacheBackup { manifest: CacheBackupManifest; entries: CacheBackupEntry[] }

function sameOwner(a: CacheOwner, b: CacheOwner): boolean { return a.tenantId === b.tenantId && a.userId === b.userId; }

function validateOutbox(resource: string, data: unknown): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:attachmentId|uploadedAttachmentId|queueId|serverQueueId|submissionId|serverSubmissionId)$/iu.test(key)) throw new CacheSchemaError('outbox_not_draft_only');
      visit(child);
    }
  };
  visit(data);
  if (resource === 'outbox-draft') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CacheSchemaError('outbox_not_draft_only');
    const draft = data as Record<string, unknown>;
    const keys = Object.keys(draft);
    if (keys.length === 0 || keys.some((key) => !OUTBOX_DRAFT_FIELDS.test(key))) throw new CacheSchemaError('outbox_not_draft_only');
    for (const [key, value] of Object.entries(draft)) {
      const valid = key === 'localDraftRefs'
        ? Array.isArray(value) && value.length > 0 && value.every((ref) => typeof ref === 'string' && ref.length > 0)
        : typeof value === 'string' && value.length > 0;
      if (!valid) throw new CacheSchemaError('outbox_not_draft_only');
    }
  }
}

function validateBackupData(resource: string, data: unknown): void {
  if (!DISPLAY_RESOURCES.has(resource)) throw new CacheSchemaError('authoritative_resource_forbidden');
  if (OUTBOX_RESOURCES.has(resource)) validateOutbox(resource, data);
  validateTree(data, '$', 0, true);
}

function manifestBody(manifest: Omit<CacheBackupManifest, 'overallDigest'>): string { return canonicalSerialize(manifest); }

export function createCacheBackup(owner: CacheOwner, input: readonly CacheEntryInput[], exportedAt = new Date().toISOString()): CacheBackup {
  if (!Number.isFinite(Date.parse(exportedAt))) throw new CacheSchemaError('invalid_export_time');
  const entries = input.map((entry) => {
    assertComponent(entry.type, 'type', RESOURCE);
    validateBackupData(entry.resource, entry.data);
    const key = CacheKeyBuilder.build(owner, entry.resource, entry.resourceId);
    const payload = canonicalSerialize(entry.data);
    return { key, type: entry.type, payload };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new CacheSchemaError('duplicate_entry');
  const descriptors = entries.map((entry) => ({ key: entry.key, type: entry.type, digest: cacheDigest(entry.payload), bytes: new TextEncoder().encode(entry.payload).byteLength }));
  const body = { schemaVersion: CACHE_SCHEMA_VERSION, owner: { tenantId: owner.tenantId, userId: owner.userId }, exportedAt, entries: descriptors };
  const backup = { manifest: { ...body, overallDigest: cacheDigest(manifestBody(body)) }, entries };
  canonicalSerialize(backup, CACHE_MAX_BACKUP_BYTES);
  return backup;
}

export interface VerifiedCacheBackup { entries: CacheBackupEntry[]; requiresFullSync: true }

function exactObjectKeys(value: unknown, expected: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function verifyCacheBackup(raw: string | CacheBackup, expectedOwner: CacheOwner): VerifiedCacheBackup {
  assertComponent(expectedOwner.tenantId, 'tenantId');
  assertComponent(expectedOwner.userId, 'userId');
  const value = typeof raw === 'string' ? parseCacheJson(raw, CACHE_MAX_BACKUP_BYTES) : raw;
  if (typeof raw !== 'string') canonicalSerialize(raw, CACHE_MAX_BACKUP_BYTES);
  if (!exactObjectKeys(value, ['entries', 'manifest'])) throw new CacheSchemaError('unknown_backup_key');
  const backup = value as CacheBackup;
  const manifest = backup.manifest;
  if (!exactObjectKeys(manifest, ['entries', 'exportedAt', 'overallDigest', 'owner', 'schemaVersion']) || manifest.schemaVersion !== CACHE_SCHEMA_VERSION) throw new CacheSchemaError('unsupported_schema');
  if (!exactObjectKeys(manifest.owner, ['tenantId', 'userId'])) throw new CacheSchemaError('owner_mismatch');
  assertComponent(manifest.owner.tenantId, 'tenantId');
  assertComponent(manifest.owner.userId, 'userId');
  if (!sameOwner(manifest.owner, expectedOwner)) throw new CacheSchemaError('owner_mismatch');
  if (!Array.isArray(manifest.entries) || !Array.isArray(backup.entries) || manifest.entries.length !== backup.entries.length) throw new CacheSchemaError('invalid_manifest');
  if (typeof manifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(manifest.exportedAt))) throw new CacheSchemaError('invalid_export_time');
  const { overallDigest, ...body } = manifest;
  if (typeof overallDigest !== 'string' || cacheDigest(manifestBody(body)) !== overallDigest) throw new CacheSchemaError('manifest_tampered');

  const manifestKeys = new Set<string>();
  const payloadByKey = new Map<string, CacheBackupEntry>();
  for (const entry of backup.entries) {
    if (!exactObjectKeys(entry, ['key', 'payload', 'type'])) throw new CacheSchemaError('unknown_entry_key');
    if (typeof entry.key !== 'string' || typeof entry.payload !== 'string' || typeof entry.type !== 'string') throw new CacheSchemaError('invalid_backup_entry');
    if (payloadByKey.has(entry.key)) throw new CacheSchemaError('duplicate_entry');
    payloadByKey.set(entry.key, entry);
  }
  for (const descriptor of manifest.entries) {
    if (!exactObjectKeys(descriptor, ['bytes', 'digest', 'key', 'type']) || typeof descriptor.key !== 'string' || typeof descriptor.type !== 'string' || !RESOURCE.test(descriptor.type) || typeof descriptor.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) throw new CacheSchemaError('unknown_manifest_key');
    if (manifestKeys.has(descriptor.key)) throw new CacheSchemaError('duplicate_entry');
    manifestKeys.add(descriptor.key);
    const parsed = CacheKeyBuilder.parse(descriptor.key);
    if (!sameOwner(parsed, expectedOwner)) throw new CacheSchemaError('owner_mismatch');
    const entry = payloadByKey.get(descriptor.key);
    if (!entry || entry.type !== descriptor.type) throw new CacheSchemaError('entry_tampered');
    const data = parseCacheJson(entry.payload);
    if (canonicalSerialize(data) !== entry.payload || cacheDigest(entry.payload) !== descriptor.digest || new TextEncoder().encode(entry.payload).byteLength !== descriptor.bytes) throw new CacheSchemaError('entry_tampered');
    validateBackupData(parsed.resource, data);
  }
  if (manifestKeys.size !== payloadByKey.size || [...payloadByKey.keys()].some((key) => !manifestKeys.has(key))) throw new CacheSchemaError('entry_tampered');
  return { entries: backup.entries.map((entry) => ({ ...entry })), requiresFullSync: true };
}

export interface AtomicCacheAdapter { atomicReplace(owner: CacheOwner, entries: readonly CacheBackupEntry[]): Promise<void> }
export interface CacheKeyValueBackend {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

interface StoredCacheBundle {
  schemaVersion: 2;
  owner: CacheOwner;
  requiresFullSync: true;
  entries: CacheBackupEntry[];
}

function validateStoredEntries(owner: CacheOwner, entries: unknown): CacheBackupEntry[] {
  if (!Array.isArray(entries)) throw new CacheSchemaError('invalid_backup_bundle');
  const keys = new Set<string>();
  return entries.map((value) => {
    if (!exactObjectKeys(value, ['key', 'payload', 'type'])) throw new CacheSchemaError('invalid_backup_bundle');
    const entry = value as CacheBackupEntry;
    if (typeof entry.key !== 'string' || typeof entry.payload !== 'string' || typeof entry.type !== 'string' || !RESOURCE.test(entry.type)) throw new CacheSchemaError('invalid_backup_bundle');
    const parsed = CacheKeyBuilder.parse(entry.key);
    if (!sameOwner(parsed, owner)) throw new CacheSchemaError('owner_mismatch');
    if (keys.has(entry.key)) throw new CacheSchemaError('duplicate_entry');
    keys.add(entry.key);
    const data = parseCacheJson(entry.payload);
    if (canonicalSerialize(data) !== entry.payload) throw new CacheSchemaError('entry_tampered');
    validateBackupData(parsed.resource, data);
    return { ...entry };
  });
}

function decodeStoredBundle(raw: string, owner: CacheOwner): StoredCacheBundle {
  const value = parseCacheJson(raw, CACHE_MAX_BACKUP_BYTES);
  if (canonicalSerialize(value, CACHE_MAX_BACKUP_BYTES) !== raw || !exactObjectKeys(value, ['entries', 'owner', 'requiresFullSync', 'schemaVersion'])) throw new CacheSchemaError('invalid_backup_bundle');
  const parsed = value as StoredCacheBundle;
  if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || parsed.requiresFullSync !== true || !exactObjectKeys(parsed.owner, ['tenantId', 'userId'])) throw new CacheSchemaError('invalid_backup_bundle');
  assertComponent(parsed.owner.tenantId, 'tenantId');
  assertComponent(parsed.owner.userId, 'userId');
  if (!sameOwner(parsed.owner, owner)) throw new CacheSchemaError('owner_mismatch');
  return { ...parsed, owner: { ...parsed.owner }, entries: validateStoredEntries(owner, parsed.entries) };
}

/** One-value commit: stage and verify the complete replacement before the only durable mutation. */
export class KeyValueAtomicCacheAdapter implements AtomicCacheAdapter {
  constructor(private readonly backend: CacheKeyValueBackend) {}
  private bundleKey(owner: CacheOwner): string { return CacheKeyBuilder.build(owner, 'backup-bundle', 'active'); }
  async atomicReplace(owner: CacheOwner, entries: readonly CacheBackupEntry[]): Promise<void> {
    const stagedEntries = validateStoredEntries(owner, entries);
    const staged = canonicalSerialize({ schemaVersion: CACHE_SCHEMA_VERSION, owner: { tenantId: owner.tenantId, userId: owner.userId }, requiresFullSync: true, entries: stagedEntries }, CACHE_MAX_BACKUP_BYTES);
    decodeStoredBundle(staged, owner);
    await this.backend.setItem(this.bundleKey(owner), staged);
  }
  async read(owner: CacheOwner): Promise<{ requiresFullSync: true; entries: CacheBackupEntry[] } | null> {
    const raw = await this.backend.getItem(this.bundleKey(owner));
    if (!raw) return null;
    const parsed = decodeStoredBundle(raw, owner);
    return { requiresFullSync: true, entries: parsed.entries };
  }
  async clear(owner: CacheOwner): Promise<void> {
    if (this.backend.removeItem) await this.backend.removeItem(this.bundleKey(owner));
  }
}

export async function restoreCacheBackup(raw: string | CacheBackup, owner: CacheOwner, adapter: AtomicCacheAdapter): Promise<VerifiedCacheBackup> {
  const staged = verifyCacheBackup(raw, owner);
  await adapter.atomicReplace(owner, staged.entries);
  return staged;
}

export interface LegacyCacheRecord { key: string; raw: string }
export interface CacheMigrationResult { entries: CacheEntryInput[]; droppedKeys: string[]; requiresFullSync: true }

function legacyOwnerFromKey(key: string): CacheOwner | null {
  const match = /(?:^|::|\.)u=([^;]+);t=([^;]+);g=\d+(?:\.[^.]+)?$/u.exec(key);
  if (!match) return null;
  try { return { userId: decodeURIComponent(match[1]), tenantId: decodeURIComponent(match[2]) }; } catch { return null; }
}

function stripLegacyAuthority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLegacyAuthority);
  if (!value || typeof value !== 'object') return value;
  const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!FORBIDDEN_PROPERTY.test(key)) clean[key] = stripLegacyAuthority(child);
  }
  return clean;
}

function legacyDisplayData(resource: string, data: unknown): unknown {
  const stripped = stripLegacyAuthority(data);
  if (resource === 'sessions' && stripped && typeof stripped === 'object' && 'sessions' in stripped) {
    return { sessions: (stripped as Record<string, unknown>).sessions };
  }
  if (resource === 'messages' && stripped && typeof stripped === 'object' && 'messages' in stripped) {
    return { messages: (stripped as Record<string, unknown>).messages };
  }
  return stripped;
}

function legacyResourceId(key: string, resource: string, envelope?: Record<string, unknown>): string {
  if (typeof envelope?.resourceId === 'string' && COMPONENT.test(envelope.resourceId)) return envelope.resourceId;
  const raw = resource === 'sessions'
    ? /^sessionList:([^:]+)::/u.exec(key)?.[1]
    : resource === 'messages'
      ? /^(?:msgCache:|agentChat\.msgCache\.)(.+?)(?:::u=|\.u=)/u.exec(key)?.[1]
      : /;g=\d+\.([^.]+)$/u.exec(key)?.[1];
  if (!raw) return 'default';
  try {
    const decoded = decodeURIComponent(raw);
    return COMPONENT.test(decoded) ? decoded : 'default';
  } catch { return 'default'; }
}

/** Reads only explicit N-1 owner-bound keys. Unknown/ownerless and authoritative records are dropped. */
export function migrateKnownLegacyCache(records: readonly LegacyCacheRecord[], owner: CacheOwner): CacheMigrationResult {
  const entries: CacheEntryInput[] = [];
  const droppedKeys: string[] = [];
  for (const record of records) {
    const legacyOwner = legacyOwnerFromKey(record.key);
    const known = /^(?:sessionList:|msgCache:|agentChat\.msgCache\.|agentChat\.inputDraft\.v2\.)/u.test(record.key);
    if (!known || !legacyOwner) { droppedKeys.push(record.key); continue; }
    if (!sameOwner(legacyOwner, owner)) throw new CacheSchemaError('owner_mismatch');
    const parsed = parseCacheJson(record.raw);
    const resource = record.key.startsWith('sessionList:') ? 'sessions' : /^(?:msgCache:|agentChat\.msgCache\.)/u.test(record.key) ? 'messages' : 'draft-metadata';
    if (resource === 'draft-metadata' && typeof parsed === 'string') {
      entries.push({ resource, resourceId: legacyResourceId(record.key, resource), type: 'draft-metadata-display', data: { text: parsed } });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CacheSchemaError('invalid_legacy_entry');
    const envelope = parsed as Record<string, unknown>;
    const version = envelope.schemaVersion ?? 1;
    if (version !== 1) throw new CacheSchemaError('unsupported_schema');
    const resourceId = legacyResourceId(record.key, resource, envelope);
    const data = legacyDisplayData(resource, envelope.data ?? parsed);
    validateBackupData(resource, data);
    entries.push({ resource, resourceId, type: `${resource}-display`, data });
  }
  return { entries, droppedKeys, requiresFullSync: true };
}

export interface CacheSyncGate { requiresFullSync: boolean; syncGeneration: number }
export function createCacheSyncGate(requiresFullSync = false): CacheSyncGate { return { requiresFullSync, syncGeneration: 0 }; }
export function markCacheRestored(state: CacheSyncGate): CacheSyncGate { return { requiresFullSync: true, syncGeneration: state.syncGeneration + 1 }; }
export function markCacheFullSyncComplete(state: CacheSyncGate, generation: number): CacheSyncGate {
  return state.requiresFullSync && generation === state.syncGeneration ? { ...state, requiresFullSync: false } : state;
}
export function assertCacheSendAllowed(state: CacheSyncGate): void {
  if (state.requiresFullSync) throw new CacheSchemaError('full_sync_required', 'send/replay is blocked until the first authoritative sync completes');
}

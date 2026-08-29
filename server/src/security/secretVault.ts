import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SecretRef {
  id: string;
  ownerId: string;
  kind: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  /**
   * Opaque version（TASK-318 config identity）：put=1，rotate 递增。
   * 只用于配置身份/轮换观测，不承载任何访问控制语义；旧数据缺省视为 1。
   */
  version?: number;
}

export type VaultOperation = 'read' | 'write' | 'rotate' | 'revoke';

export interface VaultCaller {
  actor: 'system' | 'mcp_proxy' | 'connector_proxy' | 'git_proxy';
  userId?: string;
  /**
   * 调用方所属组织。用于 tenant-scope secret 的 ACL 校验：
   *   - secret.ownerId === `tenant:<id>` → 要求 caller.tenantId === `<id>`
   *   - secret.ownerId === 'global'      → 任意 caller 可读（仅 connector/mcp/git proxy
   *     actor 通过，admin/system 本就放行；防止匿名 caller 越权读 global secret）
   *   - 其他（user scope）              → 维持 caller.userId === secret.ownerId
   */
  tenantId?: string;
  sessionId?: string;
  scopes?: string[];
}

/**
 * Owner ID 前缀约定（多组织改造 PR）：
 *   - 裸 username 或 `user:<username>` = user scope（向后兼容老 secret 直接用 username）
 *   - `tenant:<tenantId>`              = tenant scope（同组织用户共享）
 *   - `global`                         = global scope（所有组织用户可见，仅平台 admin 写）
 */
export const TENANT_OWNER_PREFIX = 'tenant:';
export const GLOBAL_OWNER_ID = 'global';
export function tenantOwnerId(tenantId: string): string {
  return `${TENANT_OWNER_PREFIX}${tenantId}`;
}
export function parseTenantOwnerId(ownerId: string): string | null {
  return ownerId.startsWith(TENANT_OWNER_PREFIX) ? ownerId.slice(TENANT_OWNER_PREFIX.length) : null;
}

export interface SecretVault {
  putSecret(ownerId: string, kind: string, value: string, caller: VaultCaller, metadata?: Record<string, unknown>): Promise<SecretRef>;
  getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string>;
  rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef>;
  revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void>;
  /** 可选：使当前进程的 plaintext cache 失效；跨进程 rotate 后强制 fresh read。 */
  invalidate?(ref: SecretRef | string): void;
  /**
   * 可选（TASK-318）：只读 ref 元数据（id/kind/owner/version 等，不含明文）。
   * Config identity 用它解析受管 ref 的 opaque version；vault 不支持时
   * 调用方应把版本视为不可验证，而不是伪造版本。
   */
  inspectRef?(ref: SecretRef | string, caller: VaultCaller): Promise<SecretRef | null>;
}

interface StoredSecret extends SecretRef {
  value: string;
}

/**
 * Development vault used by P2 wiring and tests. It intentionally keeps values
 * process-local: callers receive only SecretRef outside this boundary, never the
 * plaintext value. Production can replace this with KMS/secret-manager without
 * changing MCP/Git proxy call sites.
 */
export class InMemorySecretVault implements SecretVault {
  private readonly secrets = new Map<string, StoredSecret>();

  async putSecret(ownerId: string, kind: string, value: string, caller: VaultCaller, metadata: Record<string, unknown> = {}): Promise<SecretRef> {
    assertAllowed({ ownerId, kind }, caller, 'write');
    const now = new Date().toISOString();
    const secret: StoredSecret = {
      id: randomUUID(),
      ownerId,
      kind,
      value,
      metadata,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.secrets.set(secret.id, secret);
    return toRef(secret);
  }

  async getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string> {
    const secret = this.read(ref);
    if (secret.revokedAt) throw new Error(`secret revoked: ${secret.id}`);
    assertAllowed(secret, caller, 'read');
    return secret.value;
  }

  async rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef> {
    const secret = this.read(ref);
    assertAllowed(secret, caller, 'rotate');
    const updated: StoredSecret = { ...secret, value, updatedAt: new Date().toISOString(), revokedAt: undefined, version: nextVersion(secret) };
    this.secrets.set(secret.id, updated);
    return toRef(updated);
  }

  async revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void> {
    const secret = this.read(ref);
    assertAllowed(secret, caller, 'revoke');
    this.secrets.set(secret.id, { ...secret, revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  /** 只读元数据（不含明文）；供 config identity 解析 opaque version。 */
  async inspectRef(ref: SecretRef | string, caller: VaultCaller): Promise<SecretRef | null> {
    const id = typeof ref === 'string' ? ref : ref.id;
    const secret = this.secrets.get(id);
    if (!secret) return null;
    assertMetadataInspectionAllowed(secret, caller);
    return toRef(secret);
  }

  private read(ref: SecretRef | string): StoredSecret {
    const id = typeof ref === 'string' ? ref : ref.id;
    const secret = this.secrets.get(id);
    if (!secret) throw new Error(`secret not found: ${id}`);
    return secret;
  }
}

const SYSTEM_INFRASTRUCTURE_PRINCIPALS: Readonly<Record<string, Partial<Record<VaultOperation, readonly string[]>>>> = {
  client_daemon: { read: ['__system__'] },
  client_daemon_device: { read: ['__system__'], write: ['__system__'] },
  codex_subscription_oauth: {
    read: ['__system__'],
    write: ['__system__'],
    rotate: ['__system__'],
    revoke: ['__system__'],
  },
  'egress-proxy': { read: ['__system__'], write: ['egress_config_admin'] },
  feishu_connector: { read: ['__system__'] },
  github_app: { read: ['__system__'] },
  image_gen_tools: { read: ['__system__'], write: ['image_gen_config_admin'] },
  models: { read: ['__system__'], write: ['models_config_admin'], revoke: ['models_config_admin'] },
  memory_index: { read: ['__system__'], write: ['models_config_admin'], revoke: ['models_config_admin'] },
  server_remote: { read: ['__system__'] },
  'signup-sms': {
    read: ['auth_sms_service', 'signup_sms_service'],
    write: ['signup_config_admin'],
  },
  stt: { read: ['__system__'], write: ['__system__', 'audio_transcribe_config_admin'] },
  'tenant-hand': { read: ['__system__'], write: ['__system__'], rotate: ['__system__'] },
  tenant_hand: { read: ['__system__'], write: ['__system__'], rotate: ['__system__'] },
  web_tools: { read: ['__system__'], write: ['tool_controls_admin'] },
};

function assertSystemInfrastructurePrincipal(
  caller: VaultCaller,
  kind: string,
  operation: VaultOperation,
): void {
  const allowedPrincipals = SYSTEM_INFRASTRUCTURE_PRINCIPALS[kind]?.[operation];
  if (!allowedPrincipals) {
    throw new Error(`vault access denied (${operation}) for system: kind/operation not infrastructure allowlisted`);
  }
  if (!caller.userId || !allowedPrincipals.includes(caller.userId)) {
    throw new Error(`vault access denied (${operation}) for system: service principal mismatch`);
  }
}

function assertAllowed(
  secret: Pick<SecretRef, 'ownerId' | 'kind'>,
  caller: VaultCaller,
  operation: VaultOperation,
): void {
  if (!['system', 'mcp_proxy', 'connector_proxy', 'git_proxy'].includes(caller.actor)) {
    throw new Error(`vault access denied (${operation}): unknown actor`);
  }
  const requiredScope = `secret:${secret.kind}:${operation}`;
  if (!(caller.scopes ?? []).includes(requiredScope)) {
    throw new Error(`vault access denied (${operation}) for ${caller.actor}: missing ${requiredScope}`);
  }

  // M0 迁移兼容：system 仅保留固定基础设施 Secret kind、operation 与 Service Principal。
  if (caller.actor === 'system') {
    assertSystemInfrastructurePrincipal(caller, secret.kind, operation);
    return;
  }

  const tenant = parseTenantOwnerId(secret.ownerId);
  if (tenant !== null) {
    if (!caller.tenantId || caller.tenantId !== tenant) {
      throw new Error(`vault access denied (${operation}) for ${caller.actor}: tenant owner mismatch`);
    }
    return;
  }
  if (secret.ownerId === GLOBAL_OWNER_ID) return;
  if (!caller.userId) {
    throw new Error(`vault access denied (${operation}) for ${caller.actor}: user owner required`);
  }
  if (caller.userId !== secret.ownerId && `user:${caller.userId}` !== secret.ownerId) {
    throw new Error(`vault access denied (${operation}) for ${caller.actor}: user owner mismatch`);
  }
}

function assertCallerHasOperationScope(caller: VaultCaller, operation: VaultOperation): void {
  if (!['system', 'mcp_proxy', 'connector_proxy', 'git_proxy'].includes(caller.actor)) {
    throw new Error(`vault access denied (${operation}): unknown actor`);
  }
  const suffix = `:${operation}`;
  const kinds = (caller.scopes ?? [])
    .filter(scope => scope.startsWith('secret:') && scope.endsWith(suffix))
    .map(scope => scope.slice('secret:'.length, -suffix.length));
  if (kinds.length === 0 || kinds.some(kind => !/^[a-z0-9_-]+$/i.test(kind))) {
    throw new Error(`vault access denied (${operation}) for ${caller.actor}: exact operation scope required`);
  }
  if (caller.actor === 'system') {
    for (const kind of kinds) assertSystemInfrastructurePrincipal(caller, kind, operation);
  }
}

function opaqueVersion(secret: Pick<StoredSecret, 'id' | 'version'>): number {
  // v1 迁移：TASK-318 之前写入的 vault 数据没有 version，显式视为 1；
  // 非法值不能悄悄回退，否则 rotation identity 会失真。
  if (secret.version === undefined) return 1;
  if (!Number.isSafeInteger(secret.version) || secret.version <= 0) {
    throw new Error(`secret has invalid opaque version: ${secret.id}`);
  }
  return secret.version;
}

function toRef(secret: StoredSecret): SecretRef {
  const { value: _value, ...ref } = secret;
  return { ...ref, version: opaqueVersion(secret) };
}

function sanitizeInspectedRef(value: unknown): SecretRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('HttpSecretVault inspect response is malformed');
  }
  const raw = value as Record<string, unknown>;
  for (const field of ['id', 'ownerId', 'kind', 'createdAt'] as const) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) {
      throw new Error(`HttpSecretVault inspect response ${field} is malformed`);
    }
  }
  if (raw.updatedAt !== undefined && (typeof raw.updatedAt !== 'string' || !raw.updatedAt)) {
    throw new Error('HttpSecretVault inspect response updatedAt is malformed');
  }
  if (raw.metadata !== undefined && (!raw.metadata || typeof raw.metadata !== 'object' || Array.isArray(raw.metadata))) {
    throw new Error('HttpSecretVault inspect response metadata is malformed');
  }
  const ref: SecretRef = {
    id: raw.id as string,
    ownerId: raw.ownerId as string,
    kind: raw.kind as string,
    metadata: (raw.metadata as Record<string, unknown> | undefined) ?? {},
    createdAt: raw.createdAt as string,
    updatedAt: (raw.updatedAt as string | undefined) ?? (raw.createdAt as string),
    version: opaqueVersion(raw as unknown as SecretRef),
  };
  if (typeof raw.revokedAt === 'string' && raw.revokedAt) ref.revokedAt = raw.revokedAt;
  return ref;
}

/** opaque version 递增：旧数据没有 version 时从 1 起步（rotate 后为 2）。 */
function nextVersion(secret: StoredSecret): number {
  return opaqueVersion(secret) + 1;
}


interface FileVaultShape {
  version: 1;
  secrets: StoredSecret[];
}

/**
 * Encrypted local-file vault for development/staging. It is not a KMS
 * replacement, but it gives P2 a durable encrypted backend that can later be
 * swapped for a managed secret service behind the same SecretVault interface.
 */
export class EncryptedFileSecretVault implements SecretVault {
  private readonly key: Buffer;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, encryptionKey: string) {
    if (!encryptionKey) throw new Error('EncryptedFileSecretVault requires encryptionKey');
    this.key = createHash('sha256').update(encryptionKey).digest();
  }

  async putSecret(ownerId: string, kind: string, value: string, caller: VaultCaller, metadata: Record<string, unknown> = {}): Promise<SecretRef> {
    assertAllowed({ ownerId, kind }, caller, 'write');
    return this.withWriteLock(async () => {
      const data = await this.load();
      const now = new Date().toISOString();
      const secret: StoredSecret = { id: randomUUID(), ownerId, kind, value, metadata, createdAt: now, updatedAt: now, version: 1 };
      data.secrets.push(secret);
      await this.save(data);
      return toRef(secret);
    });
  }

  async getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string> {
    const secret = await this.read(ref);
    if (secret.revokedAt) throw new Error(`secret revoked: ${secret.id}`);
    assertAllowed(secret, caller, 'read');
    return secret.value;
  }

  async rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef> {
    return this.withWriteLock(async () => {
      const data = await this.load();
      const idx = data.secrets.findIndex((secret) => secret.id === refId(ref));
      if (idx < 0) throw new Error(`secret not found: ${refId(ref)}`);
      const current = data.secrets[idx]!;
      assertAllowed(current, caller, 'rotate');
      const updated: StoredSecret = { ...current, value, revokedAt: undefined, updatedAt: new Date().toISOString(), version: nextVersion(current) };
      data.secrets[idx] = updated;
      await this.save(data);
      return toRef(updated);
    });
  }

  async revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void> {
    await this.withWriteLock(async () => {
      const data = await this.load();
      const idx = data.secrets.findIndex((secret) => secret.id === refId(ref));
      if (idx < 0) throw new Error(`secret not found: ${refId(ref)}`);
      const current = data.secrets[idx]!;
      assertAllowed(current, caller, 'revoke');
      data.secrets[idx] = { ...current, revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await this.save(data);
    });
  }

  /** 只读元数据（不含明文）；旧记录缺少 version 时显式迁移为 1。 */
  async inspectRef(ref: SecretRef | string, caller: VaultCaller): Promise<SecretRef | null> {
    const data = await this.load();
    const secret = data.secrets.find((s) => s.id === refId(ref));
    if (!secret) return null;
    assertMetadataInspectionAllowed(secret, caller);
    return toRef(secret);
  }

  private async read(ref: SecretRef | string): Promise<StoredSecret> {
    const data = await this.load();
    const secret = data.secrets.find((s) => s.id === refId(ref));
    if (!secret) throw new Error(`secret not found: ${refId(ref)}`);
    return secret;
  }

  private async load(): Promise<FileVaultShape> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
        return { version: 1, secrets: [] };
      }
      throw err;
    }
    const envelope = JSON.parse(raw) as { iv: string; tag: string; ciphertext: string };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf-8');
    return JSON.parse(plaintext) as FileVaultShape;
  }

  private async save(data: FileVaultShape): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify({
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    }), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(() => this.withFileLock(fn), () => this.withFileLock(fn));
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      let handle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const lockStat = await stat(lockPath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      try {
        return await fn();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    }
    throw new Error(`EncryptedFileSecretVault lock timeout: ${lockPath}`);
  }
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST');
}

const CONFIG_IDENTITY_METADATA_SCOPE = 'secret:metadata:read';

/** Config identity 只能读取 ref 元数据，不能借此调用 getSecret。 */
function assertMetadataInspectionAllowed(
  secret: Pick<SecretRef, 'ownerId' | 'kind'>,
  caller: VaultCaller,
): void {
  if (hasConfigIdentityMetadataScope(caller)) return;
  assertAllowed(secret, caller, 'read');
}

function hasConfigIdentityMetadataScope(caller: VaultCaller): boolean {
  return caller.actor === 'system'
    && caller.userId === '__system__'
    && (caller.scopes ?? []).includes(CONFIG_IDENTITY_METADATA_SCOPE);
}

function refId(ref: SecretRef | string): string {
  return typeof ref === 'string' ? ref : ref.id;
}

export interface HttpSecretVaultOptions {
  baseUrl: string;
  authToken: string;
  fetchImpl?: typeof fetch;
  /** 单次 Vault HTTP 请求超时（毫秒），默认 20 秒。 */
  requestTimeoutMs?: number;
  /**
   * A3: 本地 plaintext cache TTL（毫秒）。默认 30_000；设 0 或负数关闭 cache。
   * 命中条件：未过期 + 未被 invalidate / rotate / revoke。cache key 只用 refId
   * （远端已按 caller scope 做 ACL；本地 cache 处于受信 vault adapter 内层，
   * caller 不参与 key，让同一进程多个 caller 共享 plaintext，减少 KMS 压力）。
   */
  cacheTtlMs?: number;
  /** Cache 最大条目数（默认 256）。命中 / 写入按 Map 插入顺序做 LRU 淘汰。 */
  maxCacheEntries?: number;
  /** metadata-only inspect cache TTL（默认 5 秒）；到期后重检远端 version。 */
  metadataCacheTtlMs?: number;
  /** 注入当前时间（毫秒），用于测试 TTL 行为。 */
  nowMs?: () => number;
}

const DEFAULT_HTTP_CACHE_TTL_MS = 30_000;
const DEFAULT_HTTP_METADATA_CACHE_TTL_MS = 5_000;
const DEFAULT_HTTP_CACHE_MAX_ENTRIES = 256;
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 20_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Production adapter for an external KMS/secret-manager proxy. */
export class HttpSecretVault implements SecretVault {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly metadataCacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly nowMs: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly refs = new Map<string, SecretRef>();
  private readonly refMetadataExpiresAt = new Map<string, number>();

  constructor(private readonly options: HttpSecretVaultOptions) {
    if (!options.authToken || options.authToken.length < 8) throw new Error('HttpSecretVault authToken is required');
    const parsed = new URL(options.baseUrl);
    const localHttp = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (parsed.protocol !== 'https:' && !localHttp) throw new Error('HttpSecretVault baseUrl must be https (except localhost development)');
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('HttpSecretVault requestTimeoutMs must be positive');
    }
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_HTTP_CACHE_TTL_MS;
    this.metadataCacheTtlMs =
      options.metadataCacheTtlMs ?? DEFAULT_HTTP_METADATA_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_HTTP_CACHE_MAX_ENTRIES;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async putSecret(
    ownerId: string,
    kind: string,
    value: string,
    caller: VaultCaller,
    metadata: Record<string, unknown> = {},
  ): Promise<SecretRef> {
    assertAllowed({ ownerId, kind }, caller, 'write');
    const created = await this.post<SecretRef>('/secrets', { ownerId, kind, value, caller, metadata });
    this.rememberRef(created);
    return created;
  }

  async getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string> {
    const id = refId(ref);
    this.assertRemoteOperation(ref, caller, 'read');
    const cacheKey = this.cacheKey(id, caller);
    const cached = this.readCache(cacheKey);
    if (cached !== undefined) return cached;
    const result = await this.post<{ value: string; ref?: SecretRef }>('/secrets/resolve', { ref: id, caller });
    if (result.ref) {
      assertAllowed(result.ref, caller, 'read');
      this.rememberRef(result.ref);
    }
    this.writeCache(cacheKey, result.value);
    return result.value;
  }

  /** metadata-only 远端读取；TTL 到期后重检，确保外部 rotate 会改变 observed identity。 */
  async inspectRef(ref: SecretRef | string, caller: VaultCaller): Promise<SecretRef | null> {
    const id = refId(ref);
    const known = typeof ref === 'string' ? this.refs.get(ref) : ref;
    if (known) assertMetadataInspectionAllowed(known, caller);
    else if (!hasConfigIdentityMetadataScope(caller)) {
      this.assertRemoteOperation(ref, caller, 'read');
    }
    const cached = this.readRefMetadata(id);
    if (cached) return cached;
    const response = await this.post<unknown | null>('/secrets/inspect', { ref: id, caller });
    if (!response) return null;
    const inspected = sanitizeInspectedRef(response);
    if (inspected.id !== id) throw new Error('HttpSecretVault inspect response ref id mismatch');
    assertMetadataInspectionAllowed(inspected, caller);
    this.rememberRef(inspected);
    return inspected;
  }

  async rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef> {
    const id = refId(ref);
    this.assertRemoteOperation(ref, caller, 'rotate');
    const updated = await this.post<SecretRef>(`/secrets/${encodeURIComponent(id)}/rotate`, { value, caller });
    this.invalidate(id);
    this.rememberRef(updated);
    return updated;
  }

  async revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void> {
    const id = refId(ref);
    this.assertRemoteOperation(ref, caller, 'revoke');
    await this.post(`/secrets/${encodeURIComponent(id)}/revoke`, { caller });
    this.invalidate(id);
  }

  /**
   * 主动失效本地 plaintext 与 metadata cache。外部 KMS webhook（或 admin 工具）
   * 在远端 rotate/revoke 后可调用，下一次 inspect 会立即重检 opaque version。
   */
  invalidate(ref: SecretRef | string): void {
    const id = refId(ref);
    this.invalidateCache(id);
    this.refMetadataExpiresAt.delete(id);
  }

  private rememberRef(ref: SecretRef): void {
    this.refs.set(ref.id, ref);
    if (this.metadataCacheTtlMs > 0) {
      this.refMetadataExpiresAt.set(ref.id, this.nowMs() + this.metadataCacheTtlMs);
    } else {
      this.refMetadataExpiresAt.delete(ref.id);
    }
  }

  private readRefMetadata(id: string): SecretRef | undefined {
    const expiresAt = this.refMetadataExpiresAt.get(id);
    if (expiresAt === undefined || expiresAt <= this.nowMs()) {
      this.refMetadataExpiresAt.delete(id);
      return undefined;
    }
    return this.refs.get(id);
  }

  private assertRemoteOperation(ref: SecretRef | string, caller: VaultCaller, operation: VaultOperation): void {
    const known = typeof ref === 'string' ? this.refs.get(ref) : ref;
    if (known) {
      assertAllowed(known, caller, operation);
      return;
    }
    // 旧 ref 的 owner/kind 只能由远端权威校验；本地先拒绝万能/错 operation scope。
    assertCallerHasOperationScope(caller, operation);
  }

  private cacheKey(id: string, caller: VaultCaller): string {
    return [
      id,
      caller.actor,
      caller.userId ?? '',
      caller.tenantId ?? '',
      [...(caller.scopes ?? [])].sort().join(','),
    ].join('\u0000');
  }

  private invalidateCache(id: string): void {
    const prefix = `${id}\u0000`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private readCache(id: string): string | undefined {
    if (this.cacheTtlMs <= 0) return undefined;
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.nowMs()) {
      this.cache.delete(id);
      return undefined;
    }
    // LRU touch：delete + set 让该 key 移到 Map 末尾，淘汰时优先淘汰头部。
    this.cache.delete(id);
    this.cache.set(id, entry);
    return entry.value;
  }

  private writeCache(id: string, value: string): void {
    if (this.cacheTtlMs <= 0) return;
    if (this.cache.has(id)) this.cache.delete(id);
    this.cache.set(id, { value, expiresAt: this.nowMs() + this.cacheTtlMs });
    while (this.cache.size > this.maxCacheEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
    }
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.authToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`HttpSecretVault ${path} failed: HTTP ${response.status}`);
    return await response.json() as T;
  }
}

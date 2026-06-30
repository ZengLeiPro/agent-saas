import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SecretRef {
  id: string;
  ownerId: string;
  kind: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface VaultCaller {
  actor: 'system' | 'mcp_proxy' | 'git_proxy' | 'admin';
  userId?: string;
  /**
   * 调用方所属组织。用于 tenant-scope secret 的 ACL 校验：
   *   - secret.ownerId === `tenant:<id>` → 要求 caller.tenantId === `<id>`
   *   - secret.ownerId === 'global'      → 任意 caller 可读（仅 mcp_proxy/git_proxy
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
  putSecret(ownerId: string, kind: string, value: string, metadata?: Record<string, unknown>): Promise<SecretRef>;
  getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string>;
  rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef>;
  revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void>;
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

  async putSecret(ownerId: string, kind: string, value: string, metadata: Record<string, unknown> = {}): Promise<SecretRef> {
    const now = new Date().toISOString();
    const secret: StoredSecret = {
      id: randomUUID(),
      ownerId,
      kind,
      value,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    this.secrets.set(secret.id, secret);
    return toRef(secret);
  }

  async getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string> {
    const secret = this.read(ref);
    if (secret.revokedAt) throw new Error(`secret revoked: ${secret.id}`);
    if (!isAllowed(secret, caller)) throw new Error(`vault access denied for ${caller.actor}`);
    return secret.value;
  }

  async rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef> {
    const secret = this.read(ref);
    if (!isAllowed(secret, caller)) throw new Error(`vault rotate denied for ${caller.actor}`);
    const updated: StoredSecret = { ...secret, value, updatedAt: new Date().toISOString(), revokedAt: undefined };
    this.secrets.set(secret.id, updated);
    return toRef(updated);
  }

  async revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void> {
    const secret = this.read(ref);
    if (!isAllowed(secret, caller)) throw new Error(`vault revoke denied for ${caller.actor}`);
    this.secrets.set(secret.id, { ...secret, revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  private read(ref: SecretRef | string): StoredSecret {
    const id = typeof ref === 'string' ? ref : ref.id;
    const secret = this.secrets.get(id);
    if (!secret) throw new Error(`secret not found: ${id}`);
    return secret;
  }
}

function isAllowed(secret: SecretRef, caller: VaultCaller): boolean {
  if (caller.actor === 'admin' || caller.actor === 'system') return true;
  // PR 11 多组织 secret scope ACL：
  //   - tenant:<id>  → caller.tenantId === id
  //   - global       → 任意 caller（仅在 actor 是 proxy 时通过）
  //   - 其他 (user)  → caller.userId === ownerId（兼容裸 username 与 user:<x> 两种）
  const tenant = parseTenantOwnerId(secret.ownerId);
  const scopes = new Set(caller.scopes ?? []);
  const hasScope = scopes.has(`secret:${secret.kind}:read`) || scopes.has('secret:*:read');
  if (!hasScope) return false;
  if (tenant !== null) {
    return !!caller.tenantId && caller.tenantId === tenant;
  }
  if (secret.ownerId === GLOBAL_OWNER_ID) {
    return true; // global scope 对 proxy actor 全开（actor 已通过 scope 闸门收紧）
  }
  if (!caller.userId) return false;
  // user 兼容两种：裸 username（旧）或 user:<x>（如未来引入命名空间）
  return caller.userId === secret.ownerId || `user:${caller.userId}` === secret.ownerId;
}

function toRef(secret: StoredSecret): SecretRef {
  const { value: _value, ...ref } = secret;
  return ref;
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

  async putSecret(ownerId: string, kind: string, value: string, metadata: Record<string, unknown> = {}): Promise<SecretRef> {
    return this.withWriteLock(async () => {
      const data = await this.load();
      const now = new Date().toISOString();
      const secret: StoredSecret = { id: randomUUID(), ownerId, kind, value, metadata, createdAt: now, updatedAt: now };
      data.secrets.push(secret);
      await this.save(data);
      return toRef(secret);
    });
  }

  async getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string> {
    const secret = await this.read(ref);
    if (secret.revokedAt) throw new Error(`secret revoked: ${secret.id}`);
    if (!isAllowed(secret, caller)) throw new Error(`vault access denied for ${caller.actor}`);
    return secret.value;
  }

  async rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef> {
    return this.withWriteLock(async () => {
      const data = await this.load();
      const idx = data.secrets.findIndex((secret) => secret.id === refId(ref));
      if (idx < 0) throw new Error(`secret not found: ${refId(ref)}`);
      const current = data.secrets[idx]!;
      if (!isAllowed(current, caller)) throw new Error(`vault rotate denied for ${caller.actor}`);
      const updated: StoredSecret = { ...current, value, revokedAt: undefined, updatedAt: new Date().toISOString() };
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
      if (!isAllowed(current, caller)) throw new Error(`vault revoke denied for ${caller.actor}`);
      data.secrets[idx] = { ...current, revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await this.save(data);
    });
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
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => undefined);
    return run;
  }
}

function refId(ref: SecretRef | string): string {
  return typeof ref === 'string' ? ref : ref.id;
}

export interface HttpSecretVaultOptions {
  baseUrl: string;
  authToken: string;
  fetchImpl?: typeof fetch;
  /**
   * A3: 本地 plaintext cache TTL（毫秒）。默认 30_000；设 0 或负数关闭 cache。
   * 命中条件：未过期 + 未被 invalidate / rotate / revoke。cache key 只用 refId
   * （远端已按 caller scope 做 ACL；本地 cache 处于受信 vault adapter 内层，
   * caller 不参与 key，让同一进程多个 caller 共享 plaintext，减少 KMS 压力）。
   */
  cacheTtlMs?: number;
  /** Cache 最大条目数（默认 256）。命中 / 写入按 Map 插入顺序做 LRU 淘汰。 */
  maxCacheEntries?: number;
  /** 注入当前时间（毫秒），用于测试 TTL 行为。 */
  nowMs?: () => number;
}

const DEFAULT_HTTP_CACHE_TTL_MS = 30_000;
const DEFAULT_HTTP_CACHE_MAX_ENTRIES = 256;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Production adapter for an external KMS/secret-manager proxy. */
export class HttpSecretVault implements SecretVault {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly nowMs: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: HttpSecretVaultOptions) {
    if (!options.authToken || options.authToken.length < 8) throw new Error('HttpSecretVault authToken is required');
    const parsed = new URL(options.baseUrl);
    const localHttp = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (parsed.protocol !== 'https:' && !localHttp) throw new Error('HttpSecretVault baseUrl must be https (except localhost development)');
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_HTTP_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_HTTP_CACHE_MAX_ENTRIES;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  putSecret(ownerId: string, kind: string, value: string, metadata: Record<string, unknown> = {}): Promise<SecretRef> {
    return this.post<SecretRef>('/secrets', { ownerId, kind, value, metadata });
  }

  async getSecret(ref: SecretRef | string, caller: VaultCaller): Promise<string> {
    const id = refId(ref);
    const cached = this.readCache(id);
    if (cached !== undefined) return cached;
    const result = await this.post<{ value: string }>('/secrets/resolve', { ref: id, caller });
    this.writeCache(id, result.value);
    return result.value;
  }

  async rotateSecret(ref: SecretRef | string, value: string, caller: VaultCaller): Promise<SecretRef> {
    const id = refId(ref);
    const updated = await this.post<SecretRef>(`/secrets/${encodeURIComponent(id)}/rotate`, { value, caller });
    this.invalidate(id);
    return updated;
  }

  async revokeSecret(ref: SecretRef | string, caller: VaultCaller): Promise<void> {
    const id = refId(ref);
    await this.post(`/secrets/${encodeURIComponent(id)}/revoke`, { caller });
    this.invalidate(id);
  }

  /**
   * 主动失效本地 cache entry。外部 KMS webhook（或 admin 工具）在远端 rotate/
   * revoke 后可调本方法，避免本地 cache 命中 stale plaintext。无 entry 时静默。
   */
  invalidate(ref: SecretRef | string): void {
    const id = refId(ref);
    this.cache.delete(id);
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
    });
    if (!response.ok) throw new Error(`HttpSecretVault ${path} failed: HTTP ${response.status}`);
    return await response.json() as T;
  }
}

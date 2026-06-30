import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';

import type { SecretRef, SecretVault, VaultCaller } from '../security/secretVault.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

/**
 * C1: Per-device capability token model for the client daemon reverse-WS
 * gateway. Each daemon device gets its own bearer token (`tokenVaultRef`
 * points into SecretVault; plaintext never lands in the registry table).
 * Rotation = vault.rotateSecret + lastRotatedAt bump. Revocation =
 * vault.revokeSecret + status='disabled'.
 *
 * Co-exists with the legacy shared `clientDaemon.authToken` — if a device
 * record exists, per-device wins; if not (or registry is missing), the
 * gateway falls back to shared bearer for backward compatibility.
 */

export type ClientDaemonDeviceStatus = 'active' | 'disabled';

export interface ClientDaemonDeviceRecord {
  deviceId: string;
  tokenVaultRef: string;
  status: ClientDaemonDeviceStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastRotatedAt?: string;
  metadata: Record<string, unknown>;
}

export interface RegisterDeviceInput {
  deviceId: string;
  tokenVaultRef: string;
  metadata?: Record<string, unknown>;
}

export interface ClientDaemonRegistry {
  init?(): Promise<void>;
  register(input: RegisterDeviceInput): Promise<ClientDaemonDeviceRecord>;
  get(deviceId: string): Promise<ClientDaemonDeviceRecord | null>;
  list(): Promise<ClientDaemonDeviceRecord[]>;
  markSeen(deviceId: string): Promise<void>;
  setStatus(deviceId: string, status: ClientDaemonDeviceStatus, metadataPatch?: Record<string, unknown>): Promise<ClientDaemonDeviceRecord | null>;
  markRotated(deviceId: string): Promise<ClientDaemonDeviceRecord | null>;
}

const SYSTEM_CALLER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:client_daemon_device:read'],
};

export const CLIENT_DAEMON_DEVICE_SECRET_KIND = 'client_daemon_device';
const TOKEN_ENTROPY_BYTES = 32;

/**
 * Helper: generate a fresh URL-safe bearer token for a brand-new or rotated
 * device. The plaintext is intentionally never written outside the vault —
 * the caller hands it back to the device operator once, then forgets it.
 */
export function generateClientDaemonDeviceToken(): string {
  return randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

export interface IssueDeviceTokenInput {
  deviceId?: string;
  /** Optional metadata stored on the registry row (deployment / ops tags). */
  metadata?: Record<string, unknown>;
  /** Optional explicit token (tests / migrations); auto-generated when omitted. */
  token?: string;
}

export interface IssuedDeviceCredential {
  device: ClientDaemonDeviceRecord;
  /** Plaintext bearer the operator must hand to the device exactly once. */
  bearer: string;
}

/**
 * Convenience for admin tooling — creates a vault entry + registry row in one
 * call, returning the bearer plaintext so the caller can hand it out once.
 */
export async function issueClientDaemonDeviceCredential(args: {
  registry: ClientDaemonRegistry;
  vault: SecretVault;
  input?: IssueDeviceTokenInput;
}): Promise<IssuedDeviceCredential> {
  const input = args.input ?? {};
  const deviceId = (input.deviceId ?? randomUUID()).trim();
  if (!deviceId) throw new Error('issueClientDaemonDeviceCredential: deviceId 必须非空');
  const bearer = input.token ?? generateClientDaemonDeviceToken();
  const ref = await args.vault.putSecret(deviceId, CLIENT_DAEMON_DEVICE_SECRET_KIND, bearer, {
    purpose: 'client_daemon_bearer',
    deviceId,
  });
  const device = await args.registry.register({
    deviceId,
    tokenVaultRef: ref.id,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return { device, bearer };
}

/**
 * Resolve a presented (deviceId, bearer) pair against the registry + vault.
 * Returns `true` when the device exists, is active, the vault token matches,
 * and the registry markSeen() succeeded. Returns `false` on any failure path
 * (including unknown device / disabled device / vault mismatch / vault err).
 */
export async function verifyClientDaemonBearer(args: {
  registry: ClientDaemonRegistry;
  vault: SecretVault;
  deviceId: string;
  bearer: string;
}): Promise<boolean> {
  if (!args.deviceId || !args.bearer) return false;
  const record = await args.registry.get(args.deviceId);
  if (!record || record.status !== 'active') return false;
  let expected: string;
  try {
    expected = await args.vault.getSecret(record.tokenVaultRef, SYSTEM_CALLER);
  } catch {
    return false;
  }
  if (!constantTimeEquals(expected, args.bearer)) return false;
  try { await args.registry.markSeen(args.deviceId); } catch { /* best-effort */ }
  return true;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** In-memory registry for tests / dev. */
export class InMemoryClientDaemonRegistry implements ClientDaemonRegistry {
  private readonly devices = new Map<string, ClientDaemonDeviceRecord>();

  async register(input: RegisterDeviceInput): Promise<ClientDaemonDeviceRecord> {
    const now = new Date().toISOString();
    const existing = this.devices.get(input.deviceId);
    const record: ClientDaemonDeviceRecord = {
      deviceId: input.deviceId,
      tokenVaultRef: input.tokenVaultRef,
      status: 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: existing?.lastSeenAt,
      lastRotatedAt: existing ? now : undefined,
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    };
    this.devices.set(input.deviceId, record);
    return record;
  }

  async get(deviceId: string): Promise<ClientDaemonDeviceRecord | null> {
    return this.devices.get(deviceId) ?? null;
  }

  async list(): Promise<ClientDaemonDeviceRecord[]> {
    return [...this.devices.values()];
  }

  async markSeen(deviceId: string): Promise<void> {
    const record = this.devices.get(deviceId);
    if (!record) return;
    record.lastSeenAt = new Date().toISOString();
    record.updatedAt = record.lastSeenAt;
  }

  async setStatus(deviceId: string, status: ClientDaemonDeviceStatus, metadataPatch: Record<string, unknown> = {}): Promise<ClientDaemonDeviceRecord | null> {
    const record = this.devices.get(deviceId);
    if (!record) return null;
    const updated: ClientDaemonDeviceRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.devices.set(deviceId, updated);
    return updated;
  }

  async markRotated(deviceId: string): Promise<ClientDaemonDeviceRecord | null> {
    const record = this.devices.get(deviceId);
    if (!record) return null;
    record.lastRotatedAt = new Date().toISOString();
    record.updatedAt = record.lastRotatedAt;
    return record;
  }
}

export interface PgClientDaemonRegistryOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgClientDaemonRegistry implements ClientDaemonRegistry {
  readonly pool: PgPool;
  readonly table: string;
  private readonly ownsPool: boolean;

  constructor(options: PgClientDaemonRegistryOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgClientDaemonRegistry requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.table = `${prefix}_client_daemon_devices`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        device_id TEXT PRIMARY KEY,
        token_vault_ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ,
        last_rotated_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_status_idx ON ${this.table}(status)`);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async register(input: RegisterDeviceInput): Promise<ClientDaemonDeviceRecord> {
    const result = await this.pool.query<{ row_json: any }>(
      `
      INSERT INTO ${this.table} (device_id, token_vault_ref, status, metadata)
      VALUES ($1, $2, 'active', $3::jsonb)
      ON CONFLICT (device_id) DO UPDATE SET
        token_vault_ref = EXCLUDED.token_vault_ref,
        status = 'active',
        last_rotated_at = now(),
        updated_at = now(),
        metadata = ${this.table}.metadata || EXCLUDED.metadata
      RETURNING row_to_json(${this.table}.*) AS row_json
      `,
      [input.deviceId, input.tokenVaultRef, JSON.stringify(input.metadata ?? {})],
    );
    return normalize(result.rows[0]!.row_json);
  }

  async get(deviceId: string): Promise<ClientDaemonDeviceRecord | null> {
    const result = await this.pool.query<{ row_json: any }>(
      `SELECT row_to_json(${this.table}.*) AS row_json FROM ${this.table} WHERE device_id = $1`,
      [deviceId],
    );
    return result.rows[0] ? normalize(result.rows[0].row_json) : null;
  }

  async list(): Promise<ClientDaemonDeviceRecord[]> {
    const result = await this.pool.query<{ row_json: any }>(
      `SELECT row_to_json(${this.table}.*) AS row_json FROM ${this.table} ORDER BY updated_at DESC`,
    );
    return result.rows.map((r) => normalize(r.row_json));
  }

  async markSeen(deviceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table} SET last_seen_at = now(), updated_at = now() WHERE device_id = $1`,
      [deviceId],
    );
  }

  async setStatus(deviceId: string, status: ClientDaemonDeviceStatus, metadataPatch: Record<string, unknown> = {}): Promise<ClientDaemonDeviceRecord | null> {
    const result = await this.pool.query<{ row_json: any }>(
      `
      UPDATE ${this.table}
      SET status = $2,
          metadata = metadata || $3::jsonb,
          updated_at = now()
      WHERE device_id = $1
      RETURNING row_to_json(${this.table}.*) AS row_json
      `,
      [deviceId, status, JSON.stringify(metadataPatch)],
    );
    return result.rows[0] ? normalize(result.rows[0].row_json) : null;
  }

  async markRotated(deviceId: string): Promise<ClientDaemonDeviceRecord | null> {
    const result = await this.pool.query<{ row_json: any }>(
      `
      UPDATE ${this.table}
      SET last_rotated_at = now(), updated_at = now()
      WHERE device_id = $1
      RETURNING row_to_json(${this.table}.*) AS row_json
      `,
      [deviceId],
    );
    return result.rows[0] ? normalize(result.rows[0].row_json) : null;
  }
}

function normalize(raw: any): ClientDaemonDeviceRecord {
  return {
    deviceId: raw.device_id ?? raw.deviceId,
    tokenVaultRef: raw.token_vault_ref ?? raw.tokenVaultRef,
    status: raw.status,
    createdAt: new Date(raw.created_at ?? raw.createdAt).toISOString(),
    updatedAt: new Date(raw.updated_at ?? raw.updatedAt).toISOString(),
    lastSeenAt: raw.last_seen_at ? new Date(raw.last_seen_at).toISOString() : raw.lastSeenAt,
    lastRotatedAt: raw.last_rotated_at ? new Date(raw.last_rotated_at).toISOString() : raw.lastRotatedAt,
    metadata: raw.metadata ?? {},
  };
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}

/**
 * SecretRef shape re-export so gateway / admin code can stay narrow without
 * re-importing the security barrel.
 */
export type ClientDaemonDeviceSecretRef = SecretRef;

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ConnectorConnectionStatus = 'connected' | 'disconnected';

export interface PendingRevokeRefOwner {
  userId: string;
  tenantId: string;
}

export interface ConnectorConnectionRecord {
  connectorId: string;
  username: string;
  /** 不可变用户 id；防止账号删除后同名重建继承旧凭据。 */
  userId?: string;
  tenantId: string;
  status: ConnectorConnectionStatus;
  credentialRefs: Record<string, string>;
  /** 已脱离活动连接、等待从 Vault 撤销的 ref；不包含明文。 */
  pendingRevokeRefs?: string[];
  /** 每个 pending ref 创建时的 Vault owner；防止同名账号重建后按新用户撤销旧凭据。 */
  pendingRevokeRefOwners?: Record<string, PendingRevokeRefOwner>;
  capabilities: Record<string, boolean>;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  connectedAt?: string;
}

interface ConnectorConnectionFile {
  version: 1;
  users: Record<string, Record<string, ConnectorConnectionRecord>>;
  /** 用户主动暂停的运行时连接器；未记录时默认启用，避免升级后意外停用现有授权。 */
  runtimeEnabled: Record<string, Record<string, boolean>>;
}

const EMPTY_FILE: ConnectorConnectionFile = { version: 1, users: {}, runtimeEnabled: {} };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pendingRefOwner(record: ConnectorConnectionRecord): PendingRevokeRefOwner {
  const ownerId = record.metadata?.credentialOwnerId;
  return {
    userId: typeof ownerId === 'string' && ownerId.length > 0
      ? ownerId
      : record.userId ?? record.username,
    tenantId: record.tenantId,
  };
}

function collectPendingRefOwners(
  refs: string[],
  current: ConnectorConnectionRecord | undefined,
  retiredRefs: ReadonlySet<string>,
): Record<string, PendingRevokeRefOwner> {
  const owners: Record<string, PendingRevokeRefOwner> = {};
  for (const ref of refs) {
    const owner = current?.pendingRevokeRefOwners?.[ref]
      ?? (current && retiredRefs.has(ref) ? pendingRefOwner(current) : undefined);
    if (owner) owners[ref] = owner;
  }
  return owners;
}

/**
 * 通用连接器账号状态。这里只保存 SecretVault ref 与非敏感元数据，绝不落凭据明文。
 * MCP、运行态 env 等能力是 connection 的消费者，不是 connection 的所有者。
 */
export class ConnectorConnectionStore {
  private data: ConnectorConnectionFile;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = this.load();
  }

  get(username: string, connectorId: string): ConnectorConnectionRecord | undefined {
    const record = this.data.users[username]?.[connectorId];
    return record ? clone(record) : undefined;
  }

  listForUser(username: string): ConnectorConnectionRecord[] {
    return clone(Object.values(this.data.users[username] ?? {}));
  }

  listAll(): ConnectorConnectionRecord[] {
    return clone(Object.values(this.data.users).flatMap(connections => Object.values(connections)));
  }

  isRuntimeEnabled(username: string, connectorId: string): boolean {
    return this.data.runtimeEnabled[username]?.[connectorId] !== false;
  }

  async setRuntimeEnabled(username: string, connectorId: string, enabled: boolean): Promise<void> {
    await this.mutate(() => {
      this.data.runtimeEnabled[username] = {
        ...(this.data.runtimeEnabled[username] ?? {}),
        [connectorId]: enabled,
      };
    });
  }

  async connect(input: {
    username: string;
    userId: string;
    tenantId: string;
    connectorId: string;
    credentialRefs: Record<string, string>;
    capabilities?: Record<string, boolean>;
    metadata?: Record<string, string>;
  }): Promise<ConnectorConnectionRecord> {
    let result!: ConnectorConnectionRecord;
    await this.mutate(() => {
      const now = new Date().toISOString();
      const current = this.data.users[input.username]?.[input.connectorId];
      const sameOwner = !current
        || (current.userId ? current.userId === input.userId : current.tenantId === input.tenantId);
      const nextRefs = new Set(Object.values(input.credentialRefs));
      const retiredRefs = Object.values(current?.credentialRefs ?? {}).filter(ref => !nextRefs.has(ref));
      const retiredRefSet = new Set(retiredRefs);
      const pendingRevokeRefs = Array.from(new Set([...(current?.pendingRevokeRefs ?? []), ...retiredRefs]))
        .filter(ref => !nextRefs.has(ref));
      const pendingRevokeRefOwners = collectPendingRefOwners(pendingRevokeRefs, current, retiredRefSet);
      result = {
        connectorId: input.connectorId,
        username: input.username,
        userId: input.userId,
        tenantId: input.tenantId,
        status: 'connected',
        credentialRefs: { ...input.credentialRefs },
        ...(pendingRevokeRefs.length > 0 ? { pendingRevokeRefs } : {}),
        ...(Object.keys(pendingRevokeRefOwners).length > 0 ? { pendingRevokeRefOwners } : {}),
        capabilities: { ...(sameOwner ? current?.capabilities ?? {} : {}), ...(input.capabilities ?? {}) },
        ...((input.metadata || (sameOwner && current?.metadata)) ? {
          metadata: { ...(sameOwner ? current?.metadata ?? {} : {}), ...(input.metadata ?? {}) },
        } : {}),
        createdAt: sameOwner ? current?.createdAt ?? now : now,
        updatedAt: now,
        connectedAt: now,
      };
      this.data.users[input.username] = {
        ...(this.data.users[input.username] ?? {}),
        [input.connectorId]: result,
      };
    });
    return clone(result);
  }

  async setCapability(
    username: string,
    connectorId: string,
    capability: string,
    enabled: boolean,
  ): Promise<ConnectorConnectionRecord> {
    let result!: ConnectorConnectionRecord;
    await this.mutate(() => {
      const current = this.data.users[username]?.[connectorId];
      if (!current) throw new Error(`connector connection not found: ${connectorId}`);
      result = {
        ...current,
        capabilities: { ...current.capabilities, [capability]: enabled },
        updatedAt: new Date().toISOString(),
      };
      this.data.users[username] = {
        ...this.data.users[username],
        [connectorId]: result,
      };
    });
    return clone(result);
  }

  /** 保留断开墓碑，避免启动期把旧 MCP ref 再次迁回。 */
  async disconnect(username: string, connectorId: string, tenantId: string): Promise<ConnectorConnectionRecord> {
    let result!: ConnectorConnectionRecord;
    await this.mutate(() => {
      const now = new Date().toISOString();
      const current = this.data.users[username]?.[connectorId];
      const activeRefs = Object.values(current?.credentialRefs ?? {});
      const pendingRevokeRefs = Array.from(new Set([
        ...(current?.pendingRevokeRefs ?? []),
        ...activeRefs,
      ]));
      const pendingRevokeRefOwners = collectPendingRefOwners(
        pendingRevokeRefs,
        current,
        new Set(activeRefs),
      );
      result = {
        connectorId,
        username,
        ...(current?.userId ? { userId: current.userId } : {}),
        tenantId,
        status: 'disconnected',
        credentialRefs: {},
        ...(pendingRevokeRefs.length > 0 ? { pendingRevokeRefs } : {}),
        ...(Object.keys(pendingRevokeRefOwners).length > 0 ? { pendingRevokeRefOwners } : {}),
        capabilities: { ...(current?.capabilities ?? {}), mcp: false },
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      this.data.users[username] = {
        ...(this.data.users[username] ?? {}),
        [connectorId]: result,
      };
    });
    return clone(result);
  }

  async updateMetadata(
    username: string,
    connectorId: string,
    metadata: Record<string, string>,
  ): Promise<ConnectorConnectionRecord | undefined> {
    let result: ConnectorConnectionRecord | undefined;
    await this.mutate(() => {
      const current = this.data.users[username]?.[connectorId];
      if (!current) return;
      result = {
        ...current,
        metadata: { ...(current.metadata ?? {}), ...metadata },
        updatedAt: new Date().toISOString(),
      };
      this.data.users[username][connectorId] = result;
    });
    return result ? clone(result) : undefined;
  }

  async markCredentialRevoked(username: string, connectorId: string, ref: string): Promise<void> {
    await this.mutate(() => {
      const current = this.data.users[username]?.[connectorId];
      if (!current?.pendingRevokeRefs?.includes(ref)) return;
      const pendingRevokeRefs = current.pendingRevokeRefs.filter(item => item !== ref);
      const pendingRevokeRefOwners = { ...(current.pendingRevokeRefOwners ?? {}) };
      delete pendingRevokeRefOwners[ref];
      this.data.users[username] = {
        ...this.data.users[username],
        [connectorId]: {
          ...current,
          ...(pendingRevokeRefs.length > 0 ? { pendingRevokeRefs } : { pendingRevokeRefs: undefined }),
          ...(Object.keys(pendingRevokeRefOwners).length > 0
            ? { pendingRevokeRefOwners }
            : { pendingRevokeRefOwners: undefined }),
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }

  async removeUserData(username: string): Promise<boolean> {
    let removed = false;
    await this.mutate(() => {
      if (username in this.data.users) {
        delete this.data.users[username];
        removed = true;
      }
      if (username in this.data.runtimeEnabled) {
        delete this.data.runtimeEnabled[username];
        removed = true;
      }
    });
    return removed;
  }

  private load(): ConnectorConnectionFile {
    if (!existsSync(this.filePath)) return clone(EMPTY_FILE);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ConnectorConnectionFile>;
      if (parsed.version !== 1 || !parsed.users || typeof parsed.users !== 'object') return clone(EMPTY_FILE);
      return {
        version: 1,
        users: parsed.users,
        runtimeEnabled: parsed.runtimeEnabled && typeof parsed.runtimeEnabled === 'object'
          ? parsed.runtimeEnabled
          : {},
      };
    } catch {
      return clone(EMPTY_FILE);
    }
  }

  private async mutate(operation: () => void): Promise<void> {
    const run = this.writeQueue.then(async () => {
      operation();
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      await rename(tmpPath, this.filePath);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}

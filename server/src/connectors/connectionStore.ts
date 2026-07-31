import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ConnectorConnectionStatus = 'connected' | 'disconnected';

export interface ConnectorConnectionRecord {
  connectorId: string;
  username: string;
  tenantId: string;
  status: ConnectorConnectionStatus;
  credentialRefs: Record<string, string>;
  /** 已脱离活动连接、等待从 Vault 撤销的 ref；不包含明文。 */
  pendingRevokeRefs?: string[];
  capabilities: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
  connectedAt?: string;
}

interface ConnectorConnectionFile {
  version: 1;
  users: Record<string, Record<string, ConnectorConnectionRecord>>;
}

const EMPTY_FILE: ConnectorConnectionFile = { version: 1, users: {} };

function clone<T>(value: T): T {
  return structuredClone(value);
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

  async connect(input: {
    username: string;
    tenantId: string;
    connectorId: string;
    credentialRefs: Record<string, string>;
    capabilities?: Record<string, boolean>;
  }): Promise<ConnectorConnectionRecord> {
    let result!: ConnectorConnectionRecord;
    await this.mutate(() => {
      const now = new Date().toISOString();
      const current = this.data.users[input.username]?.[input.connectorId];
      const nextRefs = new Set(Object.values(input.credentialRefs));
      const retiredRefs = Object.values(current?.credentialRefs ?? {}).filter(ref => !nextRefs.has(ref));
      const pendingRevokeRefs = Array.from(new Set([...(current?.pendingRevokeRefs ?? []), ...retiredRefs]));
      result = {
        connectorId: input.connectorId,
        username: input.username,
        tenantId: input.tenantId,
        status: 'connected',
        credentialRefs: { ...input.credentialRefs },
        ...(pendingRevokeRefs.length > 0 ? { pendingRevokeRefs } : {}),
        capabilities: { ...(current?.capabilities ?? {}), ...(input.capabilities ?? {}) },
        createdAt: current?.createdAt ?? now,
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
      const pendingRevokeRefs = Array.from(new Set([
        ...(current?.pendingRevokeRefs ?? []),
        ...Object.values(current?.credentialRefs ?? {}),
      ]));
      result = {
        connectorId,
        username,
        tenantId,
        status: 'disconnected',
        credentialRefs: {},
        ...(pendingRevokeRefs.length > 0 ? { pendingRevokeRefs } : {}),
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

  async markCredentialRevoked(username: string, connectorId: string, ref: string): Promise<void> {
    await this.mutate(() => {
      const current = this.data.users[username]?.[connectorId];
      if (!current?.pendingRevokeRefs?.includes(ref)) return;
      const pendingRevokeRefs = current.pendingRevokeRefs.filter(item => item !== ref);
      this.data.users[username] = {
        ...this.data.users[username],
        [connectorId]: {
          ...current,
          ...(pendingRevokeRefs.length > 0 ? { pendingRevokeRefs } : { pendingRevokeRefs: undefined }),
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }

  async removeUserData(username: string): Promise<boolean> {
    let removed = false;
    await this.mutate(() => {
      if (!(username in this.data.users)) return;
      delete this.data.users[username];
      removed = true;
    });
    return removed;
  }

  private load(): ConnectorConnectionFile {
    if (!existsSync(this.filePath)) return clone(EMPTY_FILE);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ConnectorConnectionFile>;
      if (parsed.version !== 1 || !parsed.users || typeof parsed.users !== 'object') return clone(EMPTY_FILE);
      return { version: 1, users: parsed.users };
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

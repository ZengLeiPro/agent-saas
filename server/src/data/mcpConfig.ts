import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename, unlink, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { McpOAuthServerConfig, McpServerConfig, McpServersFileShape } from '../mcp/clientManager.js';
import { LEGACY_TENANT_ID } from './tenants/types.js';
import { agentSettingsPath } from '../workspace/namespace.js';

export type McpRiskLevel = 'read_only' | 'workspace_write' | 'external_write' | 'credentialed_external_write';
export type McpSecretScope = 'user' | 'tenant' | 'global';
export type McpSecretTarget = 'env' | 'header';

/**
 * 组织哨兵：tenantId = '*' 表示「全局 server」，所有组织用户可见可启用，
 * 仅平台 admin 可写。组织 admin 配的 server 必须 tenantId === own。
 */
export const GLOBAL_TENANT_ID = '*';

export interface McpSecretRequirement {
  key: string;
  label: string;
  target: McpSecretTarget;
  name: string;
  scope: McpSecretScope;
  required?: boolean;
  prefix?: string;
  instructions?: string;
}

export interface ManagedMcpServer {
  id: string;
  name: string;
  description?: string;
  config: McpServerConfig;
  enabledByDefault?: boolean;
  riskLevel?: McpRiskLevel;
  secretRequirements?: McpSecretRequirement[];
  createdFromTemplateId?: string;
  createdFromTemplateVersion?: number;
  /**
   * 组织归属。多组织改造后必填。GLOBAL_TENANT_ID ('*') = 全局 server
   * （仅平台 admin 可改）；其他值 = 具体组织 slug。旧记录启动期回填
   * LEGACY_TENANT_ID。
   */
  tenantId: string;
  /** 普通用户自助添加的私有 MCP server；仅 owner 本人可见、可写。 */
  ownerUsername?: string;
  /**
   * Server 级 secret refs（scope='tenant' / 'global' 用）。key = requirement.key，
   * value = secretVault 返回的 refId。
   *
   * 作用域：
   *   - scope='tenant'：绑到本 server.tenantId；同组织所有用户共享一份
   *     （譬如组织内共用的 GitHub org PAT）
   *   - scope='global'：仅当 server.tenantId === GLOBAL_TENANT_ID 时有意义；
   *     由 platform admin 配，所有组织用户共享
   *
   * scope='user' 走 UserMcpConfig.secretRefs（按 username 隔离）。
   */
  secretRefs?: Record<string, string>;
}

export interface UserMcpConfig {
  enabledServers: string[];
  secretRefs?: Record<string, Record<string, string>>;
  oauthConnections?: Record<string, McpOAuthConnectionRecord>;
}

export type McpOAuthConnectionStatus = 'pending' | 'connected' | 'error';

/** 仅保存非敏感状态；token/client secret/verifier 均在 SecretVault。 */
export interface McpOAuthConnectionRecord {
  serverId: string;
  tenantId: string;
  status: McpOAuthConnectionStatus;
  secretRef?: string;
  pendingState?: string;
  pendingExpiresAt?: string;
  redirectUrl: string;
  returnTo: string;
  connectedAt?: string;
  updatedAt: string;
  lastError?: string;
}

export interface McpConfigData {
  version: 1;
  configVersion: number;
  servers: Record<string, ManagedMcpServer>;
  users: Record<string, UserMcpConfig>;
  builtinPresetsVersion?: number;
}

export interface McpTemplate {
  id: string;
  templateVersion: number;
  name: string;
  description: string;
  riskLevel: McpRiskLevel;
  recommendedDefault: boolean;
  server: ManagedMcpServer;
}

export interface McpSecretStatus extends McpSecretRequirement {
  configured: boolean;
}

const SAFE_MCP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const GOOGLE_OAUTH: McpOAuthServerConfig = {
  provider: 'google-workspace',
  beta: true,
  clientIdEnv: 'GOOGLE_MCP_OAUTH_CLIENT_ID',
  clientSecretEnv: 'GOOGLE_MCP_OAUTH_CLIENT_SECRET',
};

const GOOGLE_MCP_PRESETS: Array<[string, string, string, string]> = [
  ['google_gmail', 'Google Gmail', 'https://gmailmcp.googleapis.com/mcp/v1', '读取、搜索和处理 Gmail 邮件。'],
  ['google_drive', 'Google Drive', 'https://drivemcp.googleapis.com/mcp/v1', '搜索和读取 Google Drive 文件。'],
  ['google_calendar', 'Google Calendar', 'https://calendarmcp.googleapis.com/mcp/v1', '查询和维护 Google 日历与日程。'],
  ['google_chat', 'Google Chat', 'https://chatmcp.googleapis.com/mcp/v1', '访问 Google Chat 会话与消息。'],
  ['google_people', 'Google Contacts', 'https://people.googleapis.com/mcp/v1', '查询 Google 联系人与个人资料。'],
];

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: 'github',
    templateVersion: 2,
    name: 'GitHub',
    description: 'GitHub 官方 remote MCP。每位用户使用自己的 GitHub 账号授权。',
    riskLevel: 'credentialed_external_write',
    recommendedDefault: false,
    server: {
      id: 'github',
      name: 'GitHub',
      description: '访问仓库、Issue 和 Pull Request；每位用户独立授权、独立撤销。',
      enabledByDefault: false,
      riskLevel: 'credentialed_external_write',
      createdFromTemplateId: 'github',
      createdFromTemplateVersion: 2,
      tenantId: GLOBAL_TENANT_ID,
      config: {
        type: 'streamable-http',
        url: 'https://api.githubcopilot.com/mcp/',
        oauth: { provider: 'github' },
      },
      secretRequirements: [],
    },
  },
  {
    id: 'notion',
    templateVersion: 1,
    name: 'Notion',
    description: 'Notion 官方 remote MCP。每位用户授权自己的 Notion workspace。',
    riskLevel: 'credentialed_external_write',
    recommendedDefault: false,
    server: {
      id: 'notion',
      name: 'Notion',
      description: '搜索、读取和维护用户有权限访问的 Notion 页面与数据库。',
      enabledByDefault: false,
      riskLevel: 'credentialed_external_write',
      createdFromTemplateId: 'notion',
      createdFromTemplateVersion: 1,
      tenantId: GLOBAL_TENANT_ID,
      config: { type: 'streamable-http', url: 'https://mcp.notion.com/mcp', oauth: { provider: 'notion' } },
      secretRequirements: [],
    },
  },
  ...GOOGLE_MCP_PRESETS.map(([id, name, url, description]): McpTemplate => ({
    id,
    templateVersion: 1,
    name: `${name}（Beta）`,
    description: `${description} Google 官方 MCP 当前为 Developer Preview。`,
    riskLevel: 'credentialed_external_write',
    recommendedDefault: false,
    server: {
      id,
      name,
      description: `${description} 当前为 Google Developer Preview。`,
      enabledByDefault: false,
      riskLevel: 'credentialed_external_write',
      createdFromTemplateId: id,
      createdFromTemplateVersion: 1,
      tenantId: GLOBAL_TENANT_ID,
      config: { type: 'streamable-http', url, oauth: GOOGLE_OAUTH },
      secretRequirements: [],
    },
  })),
  {
    id: 'streamable-http-bearer',
    templateVersion: 1,
    name: 'HTTP MCP with Bearer token',
    description: 'Generic Streamable HTTP MCP server authenticated with an Authorization bearer token.',
    riskLevel: 'credentialed_external_write',
    recommendedDefault: false,
    server: {
      id: 'external_http',
      name: 'External HTTP MCP',
      description: 'Replace the URL and bind a per-user bearer token.',
      enabledByDefault: false,
      riskLevel: 'credentialed_external_write',
      createdFromTemplateId: 'streamable-http-bearer',
      createdFromTemplateVersion: 1,
      tenantId: GLOBAL_TENANT_ID,
      config: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      secretRequirements: [{
        key: 'bearer_token',
        label: 'Bearer token',
        target: 'header',
        name: 'Authorization',
        scope: 'user',
        prefix: 'Bearer ',
        required: true,
      }],
    },
  },
  {
    id: 'readonly-internal-http',
    templateVersion: 1,
    name: 'Internal read-only HTTP MCP',
    description: 'Template for a low-risk internal read-only MCP endpoint without user credentials.',
    riskLevel: 'read_only',
    recommendedDefault: true,
    server: {
      id: 'internal_knowledge',
      name: 'Internal Knowledge MCP',
      description: 'Read-only internal knowledge tools. Replace the URL with your MCP endpoint.',
      enabledByDefault: true,
      riskLevel: 'read_only',
      createdFromTemplateId: 'readonly-internal-http',
      createdFromTemplateVersion: 1,
      tenantId: GLOBAL_TENANT_ID,
      config: { type: 'streamable-http', url: 'https://knowledge.example.com/mcp' },
      secretRequirements: [],
    },
  },
];

export function isSafeMcpServerId(id: string): boolean {
  return SAFE_MCP_ID_RE.test(id) && !id.includes('__');
}

export class McpConfigStore {
  private data: McpConfigData = { version: 1, configVersion: 0, servers: {}, users: {} };
  private mutationChain: Promise<unknown> = Promise.resolve();
  loadFailed = false;

  constructor(private readonly filePath: string) {
    this.load();
  }

  getConfigVersion(): number {
    return this.data.configVersion;
  }

  listServers(): ManagedMcpServer[] {
    return Object.values(this.data.servers).map(s => cloneServer(s));
  }

  /** 列出对该组织可见的 catalog server（同组织 or 全局；不含用户私有）。 */
  listServersVisibleToTenant(tenantId: string): ManagedMcpServer[] {
    return this.listServers().filter(s => !s.ownerUsername && isServerVisibleToTenant(s, tenantId));
  }

  listServersVisibleToUser(username: string, tenantId: string): ManagedMcpServer[] {
    return this.listServers().filter(s => isServerVisibleToUser(s, username, tenantId));
  }

  listCatalogServers(): ManagedMcpServer[] {
    return this.listServers().filter(s => !s.ownerUsername);
  }

  listTemplates(): McpTemplate[] {
    return clone(MCP_TEMPLATES);
  }

  getServer(id: string): ManagedMcpServer | undefined {
    const s = this.data.servers[id];
    return s ? cloneServer(s) : undefined;
  }

  getUserConfig(username: string): UserMcpConfig {
    const cfg = this.data.users[username];
    if (cfg) return {
      enabledServers: [...cfg.enabledServers],
      secretRefs: clone(cfg.secretRefs ?? {}),
      oauthConnections: clone(cfg.oauthConnections ?? {}),
    };
    return { enabledServers: this.defaultEnabledServerIds(), secretRefs: {}, oauthConnections: {} };
  }

  /** 首次启动安装官方推荐连接器；已有同 id 配置不覆盖。 */
  async installBuiltinOAuthServers(): Promise<number> {
    const targetVersion = 1;
    if ((this.data.builtinPresetsVersion ?? 0) >= targetVersion) return 0;
    return this.serialize(async () => {
      if ((this.data.builtinPresetsVersion ?? 0) >= targetVersion) return 0;
      let installed = 0;
      for (const template of MCP_TEMPLATES.filter(t => ['github', 'notion'].includes(t.id) || t.id.startsWith('google_'))) {
        if (this.data.servers[template.server.id]) continue;
        this.data.servers[template.server.id] = normalizeServer(template.server);
        installed++;
      }
      this.data.builtinPresetsVersion = targetVersion;
      this.bumpVersion();
      await this.persist();
      return installed;
    });
  }

  getUserOAuthConnection(username: string, serverId: string): McpOAuthConnectionRecord | undefined {
    const record = this.data.users[username]?.oauthConnections?.[serverId];
    return record ? clone(record) : undefined;
  }

  findUserOAuthConnectionByState(state: string): { username: string; connection: McpOAuthConnectionRecord } | undefined {
    for (const [username, config] of Object.entries(this.data.users)) {
      const connection = Object.values(config.oauthConnections ?? {}).find(item => item.pendingState === state);
      if (connection) return { username, connection: clone(connection) };
    }
    return undefined;
  }

  listUserOAuthConnections(username: string): McpOAuthConnectionRecord[] {
    return clone(Object.values(this.data.users[username]?.oauthConnections ?? {}));
  }

  listOAuthConnectionsForServer(serverId: string): Array<{ username: string; connection: McpOAuthConnectionRecord }> {
    const out: Array<{ username: string; connection: McpOAuthConnectionRecord }> = [];
    for (const [username, config] of Object.entries(this.data.users)) {
      const connection = config.oauthConnections?.[serverId];
      if (connection) out.push({ username, connection: clone(connection) });
    }
    return out;
  }

  async setUserOAuthConnection(username: string, record: McpOAuthConnectionRecord): Promise<void> {
    await this.serialize(async () => {
      const current = this.data.users[username] ?? { enabledServers: this.defaultEnabledServerIds(), secretRefs: {}, oauthConnections: {} };
      this.data.users[username] = {
        ...current,
        oauthConnections: { ...(current.oauthConnections ?? {}), [record.serverId]: clone(record) },
      };
      this.bumpVersion();
      await this.persist();
    });
  }

  async deleteUserOAuthConnection(username: string, serverId: string): Promise<void> {
    await this.serialize(async () => {
      const current = this.data.users[username];
      if (!current?.oauthConnections?.[serverId]) return;
      const oauthConnections = { ...current.oauthConnections };
      delete oauthConnections[serverId];
      this.data.users[username] = { ...current, oauthConnections };
      this.bumpVersion();
      await this.persist();
    });
  }

  async removeUserData(username: string): Promise<boolean> {
    return this.serialize(async () => {
      if (!(username in this.data.users)) return false;
      delete this.data.users[username];
      this.bumpVersion();
      await this.persist();
      return true;
    });
  }

  /**
   * 按 username 取启用列表，可选 tenantId 过滤（隐藏跨组织 server——
   * 二次保险，防止「曾启用某 server 后 admin 把它 tenantId 改走」的 stale）。
   */
  getEffectiveServers(username: string, tenantId?: string): ManagedMcpServer[] {
    const enabled = new Set(this.getUserConfig(username).enabledServers);
    const all = this.listServers().filter(s => enabled.has(s.id));
    if (!tenantId) return all;
    return all.filter(s => isServerVisibleToUser(s, username, tenantId));
  }

  /** 默认启用 = enabledByDefault===true。可选 tenantId 过滤（首次启用列表也按 tenant 隔离）。 */
  defaultEnabledServerIds(tenantId?: string): string[] {
    const visible = tenantId ? this.listServersVisibleToTenant(tenantId) : this.listCatalogServers();
    return visible.filter(s => s.enabledByDefault === true).map(s => s.id);
  }

  getUserSecretStatuses(username: string, serverId: string): McpSecretStatus[] {
    const server = this.data.servers[serverId];
    if (!server) return [];
    const userRefs = this.data.users[username]?.secretRefs?.[serverId] ?? {};
    const serverRefs = server.secretRefs ?? {};
    return (server.secretRequirements ?? []).map(req => {
      const ref = req.scope === 'user' ? userRefs[req.key] : serverRefs[req.key];
      return { ...req, configured: typeof ref === 'string' && ref.length > 0 };
    });
  }

  async upsertServer(input: ManagedMcpServer): Promise<ManagedMcpServer> {
    if (!isSafeMcpServerId(input.id)) throw new Error('Invalid MCP server id');
    return this.serialize(async () => {
      const existing = this.data.servers[input.id];
      const record = normalizeServer(input);
      // 保留已存在的 server 上的 tenant/global scope secretRefs（除非入参显式覆盖）
      // —— upsert 路由不传 secretRefs（避免每次保存 server 配置都清掉绑过的 secret）。
      if (!input.secretRefs && existing?.secretRefs) {
        record.secretRefs = { ...existing.secretRefs };
      }
      this.data.servers[record.id] = record;
      for (const cfg of Object.values(this.data.users)) {
        cfg.enabledServers = cfg.enabledServers.filter(id => id in this.data.servers);
        if (cfg.secretRefs) {
          for (const serverId of Object.keys(cfg.secretRefs)) {
            if (!(serverId in this.data.servers)) delete cfg.secretRefs[serverId];
          }
        }
        if (cfg.oauthConnections) {
          for (const serverId of Object.keys(cfg.oauthConnections)) {
            if (!(serverId in this.data.servers)) delete cfg.oauthConnections[serverId];
          }
        }
      }
      if (!existing && record.enabledByDefault === true) {
        // Keep explicit user choices explicit; users without a config inherit defaults dynamically.
      }
      this.bumpVersion();
      await this.persist();
      return cloneServer(record);
    });
  }

  async deleteServer(id: string): Promise<void> {
    await this.serialize(async () => {
      delete this.data.servers[id];
      for (const cfg of Object.values(this.data.users)) {
        cfg.enabledServers = cfg.enabledServers.filter(x => x !== id);
        if (cfg.secretRefs) delete cfg.secretRefs[id];
        if (cfg.oauthConnections) delete cfg.oauthConnections[id];
      }
      this.bumpVersion();
      await this.persist();
    });
  }

  async removeTenantData(tenantId: string, usernames: Iterable<string>): Promise<{ serversRemoved: number; usersRemoved: number }> {
    return this.serialize(async () => {
      const userSet = new Set(usernames);
      const removedServerIds = new Set<string>();
      for (const [id, server] of Object.entries(this.data.servers)) {
        if (server.tenantId === tenantId || (server.ownerUsername && userSet.has(server.ownerUsername))) {
          removedServerIds.add(id);
          delete this.data.servers[id];
        }
      }

      let usersRemoved = 0;
      for (const username of userSet) {
        if (!(username in this.data.users)) continue;
        delete this.data.users[username];
        usersRemoved++;
      }

      for (const cfg of Object.values(this.data.users)) {
        if (removedServerIds.size > 0) {
          cfg.enabledServers = cfg.enabledServers.filter(id => !removedServerIds.has(id));
          if (cfg.secretRefs) {
            for (const serverId of removedServerIds) {
              delete cfg.secretRefs[serverId];
            }
          }
          if (cfg.oauthConnections) {
            for (const serverId of removedServerIds) {
              delete cfg.oauthConnections[serverId];
            }
          }
        }
      }

      const serversRemoved = removedServerIds.size;
      if (serversRemoved > 0 || usersRemoved > 0) {
        this.bumpVersion();
        await this.persist();
      }
      return { serversRemoved, usersRemoved };
    });
  }

  /**
   * 写入用户启用的 server 列表。
   * - 传 tenantId 时：仅保留该组织可见（同组织 + 全局）的 server id，过滤越界请求
   * - 不传 tenantId：仅按 id 存在性过滤（向后兼容内部调用 / 测试 fixture）
   */
  async setUserEnabledServers(username: string, enabledServers: string[], tenantId?: string): Promise<void> {
    await this.serialize(async () => {
      const dedup = Array.from(new Set(enabledServers));
      const valid = dedup.filter(id => {
        const s = this.data.servers[id];
        if (!s) return false;
        if (!tenantId) return true;
        return isServerVisibleToUser(s, username, tenantId);
      });
      const current = this.data.users[username] ?? { enabledServers: [], secretRefs: {} };
      this.data.users[username] = { ...current, enabledServers: valid };
      this.bumpVersion();
      await this.persist();
    });
  }

  async setUserSecretRef(username: string, serverId: string, key: string, refId: string): Promise<void> {
    await this.serialize(async () => {
      const server = this.data.servers[serverId];
      if (!server) throw new Error('MCP server not found');
      if (!(server.secretRequirements ?? []).some(req => req.key === key)) throw new Error('MCP secret requirement not found');
      const current = this.data.users[username] ?? { enabledServers: this.defaultEnabledServerIds(), secretRefs: {} };
      const secretRefs = clone(current.secretRefs ?? {});
      secretRefs[serverId] = { ...(secretRefs[serverId] ?? {}), [key]: refId };
      this.data.users[username] = { ...current, secretRefs };
      this.bumpVersion();
      await this.persist();
    });
  }

  /**
   * 写 server 级 secret ref（tenant/global scope）。caller 必须先校验 secret
   * requirement 的 scope ∈ {'tenant','global'} + 写权限（platform admin vs
   * 同组织 admin）。本方法不重复做权限校验，只做数据完整性检查。
   */
  async setServerSecretRef(serverId: string, key: string, refId: string): Promise<void> {
    await this.serialize(async () => {
      const server = this.data.servers[serverId];
      if (!server) throw new Error('MCP server not found');
      const req = (server.secretRequirements ?? []).find(r => r.key === key);
      if (!req) throw new Error('MCP secret requirement not found');
      if (req.scope === 'user') throw new Error('Use setUserSecretRef for user-scope secrets');
      const refs = { ...(server.secretRefs ?? {}), [key]: refId };
      this.data.servers[serverId] = { ...server, secretRefs: refs };
      this.bumpVersion();
      await this.persist();
    });
  }

  async buildUserMcpServers(username: string, workspaceRoot: string, tenantId?: string): Promise<McpServersFileShape> {
    const managed: Record<string, McpServerConfig> = {};
    for (const server of this.getEffectiveServers(username, tenantId)) {
      managed[server.id] = this.materializeSecrets(username, server);
    }
    const local = await loadWorkspaceMcpServers(workspaceRoot);
    return { mcpServers: { ...managed, ...(local.mcpServers ?? {}) } };
  }

  private materializeSecrets(username: string, server: ManagedMcpServer): McpServerConfig {
    const config = clone(server.config);
    const userRefs = this.data.users[username]?.secretRefs?.[server.id] ?? {};
    const serverRefs = server.secretRefs ?? {};
    for (const req of server.secretRequirements ?? []) {
      // PR 11 多 scope secret 取址：scope='user' 走 user 配置；'tenant'/'global'
      // 走 server 上的 secretRefs（写入路径已保证 tenant/global 写权限）
      const ref = req.scope === 'user' ? userRefs[req.key] : serverRefs[req.key];
      if (!ref) continue;
      if ('command' in config) {
        if (req.target !== 'env') continue;
        const stdio = config as Extract<McpServerConfig, { command: string }>;
        stdio.envSecretRefs = { ...(stdio.envSecretRefs ?? {}), [req.name]: ref };
      } else {
        if (req.target !== 'header') continue;
        const http = config as Extract<McpServerConfig, { type: 'http' | 'streamable-http' }>;
        http.headerSecretRefs = { ...(http.headerSecretRefs ?? {}), [req.name]: { ref, ...(req.prefix ? { prefix: req.prefix } : {}) } };
      }
    }
    return config;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn, fn);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<McpConfigData>;
      let migrated = 0;
      const servers = Object.fromEntries(Object.entries(parsed.servers ?? {}).map(([id, s]) => {
        const raw = { ...s, id } as ManagedMcpServer;
        if (!raw.tenantId) migrated++;
        return [id, normalizeServer(raw)];
      }));
      this.data = {
        version: 1,
        configVersion: parsed.configVersion ?? 0,
        servers,
        users: Object.fromEntries(Object.entries(parsed.users ?? {}).map(([username, config]) => [username, {
          enabledServers: config.enabledServers ?? [],
          secretRefs: config.secretRefs ?? {},
          oauthConnections: config.oauthConnections ?? {},
        }])),
        builtinPresetsVersion: parsed.builtinPresetsVersion,
      };
      if (migrated > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[mcpConfig] Migrated ${migrated} legacy MCP server record(s) to tenant '${LEGACY_TENANT_ID}'. Re-save via admin UI to persist.`);
      }
    } catch {
      this.loadFailed = true;
    }
  }

  private bumpVersion(): void {
    this.data.configVersion++;
  }

  private async persist(): Promise<void> {
    if (this.loadFailed) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.mcp-config.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}

async function loadWorkspaceMcpServers(workspaceRoot: string): Promise<McpServersFileShape> {
  try {
    const raw = await readFile(agentSettingsPath(workspaceRoot), 'utf-8');
    const parsed = JSON.parse(raw) as McpServersFileShape;
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    return {};
  }
}

function normalizeServer(input: ManagedMcpServer): ManagedMcpServer {
  return {
    id: input.id,
    name: input.name.trim() || input.id,
    description: input.description?.trim() || undefined,
    enabledByDefault: input.enabledByDefault === true,
    riskLevel: input.riskLevel ?? inferRisk(input),
    config: clone(input.config),
    secretRequirements: (input.secretRequirements ?? []).map(req => ({ ...req, required: req.required !== false })),
    createdFromTemplateId: input.createdFromTemplateId,
    createdFromTemplateVersion: input.createdFromTemplateVersion,
    // 多组织改造：缺失 tenantId 的输入（旧 record / 单元测试 fixture）
    // 回填 LEGACY_TENANT_ID。GLOBAL_TENANT_ID ('*') 不做默认回填，
    // 避免把现有 server 意外提权到全局。
    tenantId: input.tenantId || LEGACY_TENANT_ID,
    ownerUsername: input.ownerUsername || undefined,
    // tenant/global scope secret refs（保留入库；缺失则不持久化 undefined）
    secretRefs: input.secretRefs && Object.keys(input.secretRefs).length > 0
      ? { ...input.secretRefs }
      : undefined,
  };
}

/** 判断 server 是否对该组织可见（同组织 or 全局）。 */
export function isServerVisibleToTenant(server: ManagedMcpServer, tenantId: string): boolean {
  return server.tenantId === tenantId || server.tenantId === GLOBAL_TENANT_ID;
}

export function isServerVisibleToUser(server: ManagedMcpServer, username: string, tenantId: string): boolean {
  if (server.ownerUsername) return server.ownerUsername === username;
  return isServerVisibleToTenant(server, tenantId);
}

function inferRisk(input: ManagedMcpServer): McpRiskLevel {
  if ((input.secretRequirements ?? []).length > 0) return 'credentialed_external_write';
  if (input.riskLevel) return input.riskLevel;
  return 'workspace_write';
}

function cloneServer(server: ManagedMcpServer): ManagedMcpServer {
  return normalizeServer(clone(server));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

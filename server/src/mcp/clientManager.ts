/**
 * MCP Client Manager — 平替 3000 时代 Claude SDK 内置 MCP 客户端能力。
 *
 * 输入：用户工作区下 `.ky-agent/settings.json` 中的 `mcpServers` 块，或平台
 * managed MCP config provider。
 *
 * 行为：
 *  - 每个 user 第一次需要时 lazy-connect：spawn stdio MCP server 或 dial Streamable
 *    HTTP MCP server；
 *  - 连上后 `client.listTools()` 拉描述符；`notifications/tools/list_changed` 只刷新
 *    manager 的未来目录，已开始的 Agent session 仍由 runtime snapshot 保持稳定；
 *  - 工具名拼成 `mcp__<serverName>__<toolName>` 与 3000 历史口径一致；
 *  - 提供 `invoke(toolKey, input)` 走对应 client.callTool。
 *
 * 安全要点（δ 阶段修复，详见 assets/20260614/平替验证/p0c-mcp对照.md + γ 阶段
 *   review）：
 *  1) stdio 子进程 env 不再 spread process.env — 改为只透传白名单（PATH/HOME/
 *     SHELL/TERM/USER/LOGNAME 等无敏感量），叠加 user 在 settings.json 显式声明的
 *     env。防止 OPENAI_API_KEY / JWT_SECRET / RUNTIME_PG_URL 泄漏给任意用户配置的
 *     子进程。
 *  2) HTTP transport URL 做 SSRF 防御：scheme 限 http/https；host 拒绝私有 CIDR、
 *     loopback、链路本地、AWS metadata、Tailscale CGNAT。
 *  3) ensureUser 用 in-flight Promise map 去重，并发同 username 不会重复 spawn。
 *  4) parseMcpToolKey 拒绝 serverName 含 '__'（infall）；ensureUser 启动时同样验。
 *  5) loadMcpServersConfig 区分 ENOENT（视为无配置）与 JSON parse / 其他 IO 错误
 *     （logger.warn 出来），且加 256KB size cap 防 settings.json 撑爆。
 *  6) invoke 加 10min timeout + 256KB 结果 cap + audit；MCP server hung 不会无限卡 dispatch。
 *  7) formatMcpResult 跳过 base64 image 全量内联，输出 placeholder + 处理 isError。
 *  8) listAndDescribeTools 加 MAX_TOOLS_PER_SERVER + cursor 防环 + 同 server 工具
 *     名去重。
 *  9) 失败 server 不进 entries 永久缓存（允许下次 ensureUser 重试，避免 npx 首次
 *     冷启动失败导致整个 lifecycle MCP 失效）。
 */

import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { rejectPlaintextSecretMap } from '../security/secretHeuristics.js';
import type { SecretVault } from '../security/secretVault.js';
import type { Logger } from '../utils/logger.js';
import { agentSettingsPath } from '../workspace/namespace.js';

export type McpServerConfig =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      envSecretRefs?: Record<string, string>;
      type?: 'stdio';
    }
  | {
      type: 'http' | 'streamable-http';
      url: string;
      headers?: Record<string, string>;
      headerSecretRefs?: Record<string, string | { ref: string; prefix?: string }>;
      oauth?: McpOAuthServerConfig;
    };

export interface McpOAuthServerConfig {
  provider: 'github' | 'notion' | 'google-workspace' | 'generic';
  beta?: boolean;
  scopes?: string[];
  /** 静态 OAuth client（Google Workspace）由平台环境变量提供；不写入 catalog。 */
  clientIdEnv?: string;
  clientSecretEnv?: string;
}

export interface McpServersFileShape {
  mcpServers?: Record<string, McpServerConfig>;
  serverMetadata?: Record<string, McpServerMetadata>;
}

export interface McpServerMetadata {
  name: string;
  description?: string;
}

export interface McpToolDescriptor {
  serverName: string;
  serverDisplayName?: string;
  serverDescription?: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConnectionStatus {
  serverName: string;
  status: 'connected' | 'error';
  toolCount: number;
  checkedAt: string;
  lastError?: string;
  nextRetryAt?: string;
}

interface InternalConnectionStatus {
  status: 'connected' | 'error';
  toolCount: number;
  checkedAt: number;
  attempts: number;
  lastError?: string;
  nextRetryAt?: number;
}

interface UserMcpEntry {
  username: string;
  workspaceRoot: string;
  servers: Map<string, ConnectedServer>;
  connectionStatuses: Map<string, InternalConnectionStatus>;
}

interface ConnectedServer {
  client: Client;
  tools: McpToolDescriptor[];
  shutdown(): Promise<void>;
}

export interface McpClientManagerOptions {
  /** Workspace base path（与 dispatch agentCwd 同源）。 */
  agentCwd: string;
  /** 失败时是否抛出（默认 false：连不上的 server 静默跳过）。 */
  failOnError?: boolean;
  /** stdio 子进程连接 timeout（默认 5s，超时跳过该 server）。 */
  connectTimeoutMs?: number;
  /** invoke callTool 默认 timeout（默认 10min）。 */
  invokeTimeoutMs?: number;
  /** invoke 返回 content 最大字节数（默认 256KB），超出截断。 */
  maxResultBytes?: number;
  /** 失败 server 的逐次重试间隔；主要供测试覆盖，生产使用默认退避。 */
  retryDelaysMs?: number[];
  logger?: Logger;
  /** Optional vault used to resolve mcpServers.*.envSecretRefs/headerSecretRefs before connect. */
  secretVault?: SecretVault;
  /** Optional managed-config provider. Falls back to workspace .ky-agent/settings.json when omitted. */
  configProvider?: (username: string, workspaceRoot: string) => Promise<McpServersFileShape>;
  /** Optional user workspace resolver for tenant-aware layouts. */
  workspaceResolver?: (username: string) => string;
  /**
   * Optional tenant resolver. 传入则 mcp_proxy 调 vault.getSecret 时把 username
   * 所属组织附在 VaultCaller.tenantId 上，让 secret.ownerId 为 tenant:<id> /
   * global 的 secret 通过 ACL（PR 11 多 scope secret）。
   */
  tenantResolver?: (username: string) => string | undefined;
  /** 为已由当前用户授权的 remote MCP 创建 OAuth provider。 */
  oauthProviderFactory?: (args: {
    username: string;
    tenantId?: string;
    serverName: string;
    config: Extract<McpServerConfig, { type: 'http' | 'streamable-http' }>;
  }) => Promise<OAuthClientProvider | undefined>;
}

// 单一 stdio 子进程允许继承的 env 白名单（参考 MCP SDK 官方 DEFAULT_INHERITED_ENV_VARS）
const STDIO_ALLOWED_ENV: ReadonlySet<string> = new Set([
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  // node 子进程必需
  'NODE_PATH',
  'NODE_OPTIONS',
  'NVM_DIR',
  // npm/pnpm 寻找全局 bin
  'NPM_CONFIG_PREFIX',
]);

const SETTINGS_JSON_MAX_BYTES = 256 * 1024;
const MAX_TOOLS_PER_SERVER = 256;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

/** 私有 / 内网 / 元数据 CIDR 黑名单（IPv4）。 */
function isPrivateIPv4(host: string): boolean {
  // 拒绝 IPv4 私网、loopback、链路本地、AWS metadata、Tailscale CGNAT (100.64/10)
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // metadata + link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT
  if (a === 0) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe80')) return true; // link-local
  return false;
}

/** 校验 MCP server URL，拒绝 SSRF 高风险目标。 */
export function assertSafeMcpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`MCP server URL invalid: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP server URL must be http(s): ${rawUrl}`);
  }
  const hostname = url.hostname;
  // 显式 localhost / 内部域
  if (
    hostname === 'localhost'
    || hostname === '0.0.0.0'
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    throw new Error(`MCP server URL rejected (loopback/internal host): ${hostname}`);
  }
  // IP 直连：直接拒绝私网
  const ipv = isIP(hostname);
  if (ipv === 4 && isPrivateIPv4(hostname)) {
    throw new Error(`MCP server URL rejected (private IPv4): ${hostname}`);
  }
  if (ipv === 6 && isPrivateIPv6(hostname)) {
    throw new Error(`MCP server URL rejected (private IPv6): ${hostname}`);
  }
  return url;
}

function pickAllowedEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of STDIO_ALLOWED_ENV) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

export class McpClientManager {
  private readonly entries = new Map<string, UserMcpEntry>();
  private readonly inflight = new Map<string, Promise<UserMcpEntry>>();
  private readonly options: Required<Omit<McpClientManagerOptions, 'logger' | 'secretVault' | 'configProvider' | 'workspaceResolver' | 'tenantResolver' | 'oauthProviderFactory'>> & {
    logger?: Logger;
    secretVault?: SecretVault;
    configProvider?: (username: string, workspaceRoot: string) => Promise<McpServersFileShape>;
    workspaceResolver?: (username: string) => string;
    tenantResolver?: (username: string) => string | undefined;
    oauthProviderFactory?: McpClientManagerOptions['oauthProviderFactory'];
  };

  constructor(options: McpClientManagerOptions) {
    this.options = {
      agentCwd: options.agentCwd,
      failOnError: options.failOnError ?? false,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      invokeTimeoutMs: options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
      maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      retryDelaysMs: options.retryDelaysMs?.length ? [...options.retryDelaysMs] : DEFAULT_RETRY_DELAYS_MS,
      logger: options.logger,
      secretVault: options.secretVault,
      configProvider: options.configProvider,
      workspaceResolver: options.workspaceResolver,
      tenantResolver: options.tenantResolver,
      oauthProviderFactory: options.oauthProviderFactory,
    };
  }

  /**
   * 获取 username 当前可用的工具描述符（自动 lazy-connect）。
   * 并发同 username 共享同一 in-flight Promise。
   */
  async ensureUser(username: string | undefined): Promise<McpToolDescriptor[]> {
    if (!username) return [];
    const existing = this.entries.get(username);
    const shouldRetry = existing
      ? [...existing.connectionStatuses.values()].some(status =>
          status.status === 'error' && (status.nextRetryAt ?? 0) <= Date.now(),
        )
      : false;
    if (existing && !shouldRetry) {
      return [...existing.servers.values()].flatMap((s) => s.tools);
    }
    let pending = this.inflight.get(username);
    if (!pending) {
      pending = existing
        ? this._retryFailedServers(username, existing)
        : this._connectAllForUser(username);
      this.inflight.set(username, pending);
    }
    try {
      const entry = await pending;
      return [...entry.servers.values()].flatMap((s) => s.tools);
    } catch (err) {
      if (this.options.failOnError) throw err;
      return [];
    } finally {
      this.inflight.delete(username);
    }
  }

  private async _connectAllForUser(username: string): Promise<UserMcpEntry> {
    const workspaceRoot = this.options.workspaceResolver?.(username) ?? join(this.options.agentCwd, username);
    const entry: UserMcpEntry = {
      username,
      workspaceRoot,
      servers: new Map(),
      connectionStatuses: new Map(),
    };

    const config = this.options.configProvider
      ? await this.options.configProvider(username, workspaceRoot)
      : await loadMcpServersConfig(workspaceRoot, this.options.logger);
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers ?? {})) {
      if (serverName.includes('__')) {
        this._recordConnectionFailure(
          entry,
          serverName,
          new Error(`server name "${serverName}" contains "__" — rejected (would clash with tool key parser)`),
        );
        continue;
      }
      try {
        await this._connectServerForUser(entry, serverName, serverConfig, config.serverMetadata?.[serverName]);
      } catch (err) {
        this._recordConnectionFailure(entry, serverName, err);
        if (this.options.failOnError) throw err;
      }
    }

    // 全部尝试完才进 entries（避免半连状态被并发 reader 看到）
    this.entries.set(username, entry);
    return entry;
  }

  private async _retryFailedServers(username: string, entry: UserMcpEntry): Promise<UserMcpEntry> {
    const config = this.options.configProvider
      ? await this.options.configProvider(username, entry.workspaceRoot)
      : await loadMcpServersConfig(entry.workspaceRoot, this.options.logger);
    const now = Date.now();
    for (const [serverName, status] of entry.connectionStatuses) {
      if (status.status !== 'error' || (status.nextRetryAt ?? 0) > now) continue;
      const serverConfig = config.mcpServers?.[serverName];
      if (!serverConfig) {
        entry.connectionStatuses.delete(serverName);
        continue;
      }
      try {
        await this._connectServerForUser(entry, serverName, serverConfig, config.serverMetadata?.[serverName]);
      } catch (err) {
        this._recordConnectionFailure(entry, serverName, err);
        if (this.options.failOnError) throw err;
      }
    }
    return entry;
  }

  private async _connectServerForUser(
    entry: UserMcpEntry,
    serverName: string,
    serverConfig: McpServerConfig,
    serverMetadata?: McpServerMetadata,
  ): Promise<void> {
    const { username } = entry;
    const resolvedConfig = await resolveMcpServerSecrets({
      username,
      tenantId: this.options.tenantResolver?.(username),
      serverName,
      config: serverConfig,
      vault: this.options.secretVault,
    });
    const oauthProvider = !isStdioConfig(resolvedConfig) && resolvedConfig.oauth
      ? await this.options.oauthProviderFactory?.({
          username,
          tenantId: this.options.tenantResolver?.(username),
          serverName,
          config: resolvedConfig,
        })
      : undefined;
    if (!isStdioConfig(resolvedConfig) && resolvedConfig.oauth && !oauthProvider) {
      throw new Error('OAuth connection is not authorized for this user');
    }
    const connected = await this._connectServerWithTimeout(
      serverName,
      resolvedConfig,
      oauthProvider,
      serverMetadata,
      (tools) => {
        entry.connectionStatuses.set(serverName, {
          status: 'connected',
          toolCount: tools.length,
          checkedAt: Date.now(),
          attempts: 0,
        });
      },
    );
    if (connected.tools.length === 0) {
      await connected.shutdown().catch(() => undefined);
      throw new Error('MCP server connected but returned no tools');
    }
    entry.servers.set(serverName, connected);
    entry.connectionStatuses.set(serverName, {
      status: 'connected',
      toolCount: connected.tools.length,
      checkedAt: Date.now(),
      attempts: 0,
    });
    this.options.logger?.info(
      `MCP[${username}] connected server=${serverName} tools=${connected.tools.length}`,
    );
  }

  private _recordConnectionFailure(entry: UserMcpEntry, serverName: string, error: unknown): void {
    const message = sanitizeConnectionError(error);
    const previous = entry.connectionStatuses.get(serverName);
    const attempts = previous?.status === 'error' ? previous.attempts + 1 : 1;
    const delay = this.options.retryDelaysMs[Math.min(attempts - 1, this.options.retryDelaysMs.length - 1)];
    const checkedAt = Date.now();
    entry.connectionStatuses.set(serverName, {
      status: 'error',
      toolCount: 0,
      checkedAt,
      attempts,
      lastError: message,
      nextRetryAt: checkedAt + delay,
    });
    this.options.logger?.warn(`MCP[${entry.username}] failed to connect ${serverName}: ${message}`);
  }

  private async _connectServerWithTimeout(
    serverName: string,
    config: McpServerConfig,
    oauthProvider?: OAuthClientProvider,
    serverMetadata?: McpServerMetadata,
    onToolsChanged?: (tools: McpToolDescriptor[]) => void,
  ): Promise<ConnectedServer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.connectTimeoutMs);
    try {
      return await Promise.race([
        connectServer(
          serverName,
          config,
          this.options.logger,
          oauthProvider,
          serverMetadata,
          onToolsChanged,
        ),
        new Promise<ConnectedServer>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`connect timeout after ${this.options.connectTimeoutMs}ms`)),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 调一个 MCP 工具。toolKey 形如 `mcp__<serverName>__<toolName>`。
   * timeout / size cap / audit 都在这里施加。
   */
  async invoke(
    username: string | undefined,
    toolKey: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    if (!username) throw new Error(`MCP invoke: missing username for ${toolKey}`);
    const parsed = parseMcpToolKey(toolKey);
    if (!parsed) throw new Error(`MCP invoke: invalid tool key ${toolKey}`);
    await this.ensureUser(username);

    const entry = this.entries.get(username);
    const server = entry?.servers.get(parsed.serverName);
    if (!server) throw new Error(`MCP invoke: server ${parsed.serverName} not connected for ${username}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.invokeTimeoutMs);
    try {
      const result = await Promise.race([
        server.client.callTool({ name: parsed.toolName, arguments: input }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`MCP invoke timeout after ${this.options.invokeTimeoutMs}ms`)),
          );
        }),
      ]);
      return formatMcpResult(result, this.options.maxResultBytes);
    } catch (err) {
      await server.shutdown().catch(() => undefined);
      entry?.servers.delete(parsed.serverName);
      if (entry) this._recordConnectionFailure(entry, parsed.serverName, err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  getUserConnectionStatuses(username: string | undefined): McpServerConnectionStatus[] {
    if (!username) return [];
    const entry = this.entries.get(username);
    if (!entry) return [];
    return [...entry.connectionStatuses.entries()].map(([serverName, status]) => ({
      serverName,
      status: status.status,
      toolCount: status.toolCount,
      checkedAt: new Date(status.checkedAt).toISOString(),
      ...(status.lastError ? { lastError: status.lastError } : {}),
      ...(status.nextRetryAt ? { nextRetryAt: new Date(status.nextRetryAt).toISOString() } : {}),
    }));
  }

  async shutdown(): Promise<void> {
    const all: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      for (const server of entry.servers.values()) {
        all.push(server.shutdown().catch(() => undefined));
      }
    }
    await Promise.all(all);
    this.entries.clear();
    this.inflight.clear();
  }

  async invalidateUser(username: string | undefined): Promise<void> {
    if (!username) return;
    const entry = this.entries.get(username);
    if (entry) {
      await Promise.all([...entry.servers.values()].map(s => s.shutdown().catch(() => undefined)));
    }
    this.entries.delete(username);
    this.inflight.delete(username);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

export function parseMcpToolKey(toolKey: string): { serverName: string; toolName: string } | null {
  if (!toolKey.startsWith('mcp__')) return null;
  const rest = toolKey.slice('mcp__'.length);
  const idx = rest.indexOf('__');
  if (idx < 0) return null;
  const serverName = rest.slice(0, idx);
  const toolName = rest.slice(idx + '__'.length);
  // ensureUser 已经拒绝 serverName 含 '__'；这里冗余守一道
  if (serverName.includes('__') || !serverName || !toolName) return null;
  return { serverName, toolName };
}

export function buildMcpToolKey(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

async function loadMcpServersConfig(
  workspaceRoot: string,
  logger?: Logger,
): Promise<McpServersFileShape> {
  const settingsPath = agentSettingsPath(workspaceRoot);
  let st;
  try {
    st = await stat(settingsPath);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') {
      logger?.warn(`MCP settings stat failed: ${settingsPath} (${errnoCode(err)})`);
    }
    return {};
  }
  if (st.size > SETTINGS_JSON_MAX_BYTES) {
    logger?.warn(
      `MCP settings.json too large (${st.size}B > ${SETTINGS_JSON_MAX_BYTES}B): ${settingsPath} — skipped`,
    );
    return {};
  }
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch (err) {
    logger?.warn(`MCP settings read failed: ${settingsPath} (${errnoCode(err)})`);
    return {};
  }
  try {
    return (JSON.parse(raw) as McpServersFileShape) ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`MCP settings.json JSON parse failed: ${settingsPath} — ${msg}`);
    return {};
  }
}

function errnoCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'UNKNOWN';
}



async function resolveMcpServerSecrets(args: {
  username: string;
  tenantId?: string;
  serverName: string;
  config: McpServerConfig;
  vault?: SecretVault;
}): Promise<McpServerConfig> {
  const { username, tenantId, serverName, config, vault } = args;
  // PR 11 多 scope secret：caller 加 tenantId，让 ownerId=tenant:<id>/global 的
  // secret 通过 vault ACL（user-scope 行为不变：caller.userId === username）
  const baseCaller = { actor: 'mcp_proxy' as const, userId: username, tenantId, scopes: ['secret:mcp:read'] };
  if (isStdioConfig(config)) {
    rejectPlaintextSecretMap(config.env, `MCP[${username}] ${serverName} env`);
    const env = { ...(config.env ?? {}) };
    const refs = validateSecretRefMap(config.envSecretRefs, `MCP[${username}] ${serverName} envSecretRefs`);
    if (Object.keys(refs).length > 0 && !vault) throw new Error(`MCP[${username}] ${serverName} envSecretRefs configured but no SecretVault is available`);
    for (const [name, ref] of Object.entries(refs)) {
      env[name] = await vault!.getSecret(ref, baseCaller);
    }
    const { envSecretRefs: _envSecretRefs, ...rest } = config;
    return { ...rest, env };
  }
  rejectPlaintextSecretMap(config.headers, `MCP[${username}] ${serverName} headers`);
  const headers = { ...(config.headers ?? {}) };
  const refs = validateHeaderSecretRefs(config.headerSecretRefs, `MCP[${username}] ${serverName} headerSecretRefs`);
  if (Object.keys(refs).length > 0 && !vault) throw new Error(`MCP[${username}] ${serverName} headerSecretRefs configured but no SecretVault is available`);
  for (const [name, descriptor] of Object.entries(refs)) {
    headers[name] = applySecretPrefix(
      descriptor.prefix ?? '',
      await vault!.getSecret(descriptor.ref, baseCaller),
    );
  }
  const { headerSecretRefs: _headerSecretRefs, ...rest } = config;
  return { ...rest, headers };
}

function applySecretPrefix(prefix: string, secret: string): string {
  const prefixToken = prefix.trim();
  const trimmedSecret = secret.trim();
  if (!prefixToken) return trimmedSecret;
  const existingPrefix = trimmedSecret.slice(0, prefixToken.length);
  const nextCharacter = trimmedSecret.slice(prefixToken.length, prefixToken.length + 1);
  if (existingPrefix.toLocaleLowerCase() === prefixToken.toLocaleLowerCase() && /\s/.test(nextCharacter)) {
    return `${prefix}${trimmedSecret.slice(prefixToken.length).trimStart()}`;
  }
  return `${prefix}${trimmedSecret}`;
}

function sanitizeConnectionError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s?#]+\?[^\s]+/gi, (url) => url.split('?')[0])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000) || 'unknown_error';
}

function validateSecretRefMap(value: unknown, label: string): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error(`${label}.${key} must be a non-empty secret ref string`);
    out[key] = ref.trim();
  }
  return out;
}

function validateHeaderSecretRefs(value: unknown, label: string): Record<string, { ref: string; prefix?: string }> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const out: Record<string, { ref: string; prefix?: string }> = {};
  for (const [key, descriptor] of Object.entries(value as Record<string, unknown>)) {
    if (typeof descriptor === 'string') {
      if (!descriptor.trim()) throw new Error(`${label}.${key} must be a non-empty secret ref string`);
      out[key] = { ref: descriptor.trim() };
      continue;
    }
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error(`${label}.${key} must be a secret ref string or object`);
    const obj = descriptor as Record<string, unknown>;
    if (typeof obj.ref !== 'string' || !obj.ref.trim()) throw new Error(`${label}.${key}.ref must be a non-empty string`);
    if (obj.prefix !== undefined && typeof obj.prefix !== 'string') throw new Error(`${label}.${key}.prefix must be a string`);
    out[key] = { ref: obj.ref.trim(), ...(typeof obj.prefix === 'string' ? { prefix: obj.prefix } : {}) };
  }
  return out;
}

// looksLikeSecret / isSensitiveMcpKey / rejectPlaintextSecretMap moved to
// ../security/secretHeuristics so tenant remote hand schema can share them.


async function connectServer(
  serverName: string,
  config: McpServerConfig,
  logger?: Logger,
  oauthProvider?: OAuthClientProvider,
  serverMetadata?: McpServerMetadata,
  onToolsChanged?: (tools: McpToolDescriptor[]) => void,
): Promise<ConnectedServer> {
  const client = new Client(
    { name: `agent-saas/${serverName}`, version: '0.1.0' },
    { capabilities: {} },
  );

  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (isStdioConfig(config)) {
    if (!config.command) {
      throw new Error(`stdio server "${serverName}" missing required field: command`);
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: pickAllowedEnv(config.env),
    });
  } else {
    if (!config.url) {
      throw new Error(`http server "${serverName}" missing required field: url`);
    }
    const safeUrl = assertSafeMcpUrl(config.url);
    transport = new StreamableHTTPClientTransport(safeUrl, {
      requestInit: { headers: config.headers ?? {} },
      ...(oauthProvider ? { authProvider: oauthProvider } : {}),
    });
  }

  await client.connect(transport);
  const connected: ConnectedServer = {
    client,
    tools: await listAndDescribeTools(client, serverName, serverMetadata),
    async shutdown() {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
  if (typeof client.setNotificationHandler === 'function') {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        const tools = await listAndDescribeTools(client, serverName, serverMetadata);
        connected.tools = tools;
        onToolsChanged?.(tools);
        logger?.info(`MCP tools/list_changed refreshed server=${serverName} tools=${tools.length}`);
      } catch (err) {
        logger?.warn(
          `MCP tools/list_changed refresh failed server=${serverName}: ${sanitizeConnectionError(err)}`,
        );
      }
    });
  }
  return connected;
}

function isStdioConfig(config: McpServerConfig): config is Extract<McpServerConfig, { command: string }> {
  // 显式 type='stdio' 或 type 缺失但有 command
  if ('type' in config && config.type !== undefined) {
    return config.type === 'stdio';
  }
  return 'command' in config && typeof (config as { command?: unknown }).command === 'string';
}

async function listAndDescribeTools(
  client: Client,
  serverName: string,
  serverMetadata?: McpServerMetadata,
): Promise<McpToolDescriptor[]> {
  const out: McpToolDescriptor[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (pages++ > 32) break; // 防 server bug 死循环
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const tool of page.tools ?? []) {
      if (out.length >= MAX_TOOLS_PER_SERVER) break;
      if (seenNames.has(tool.name)) continue; // server bug 重名去重
      seenNames.add(tool.name);
      out.push({
        serverName,
        serverDisplayName: serverMetadata?.name?.trim() || serverName,
        ...(serverMetadata?.description?.trim()
          ? { serverDescription: serverMetadata.description.trim() }
          : {}),
        toolName: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      });
    }
    if (out.length >= MAX_TOOLS_PER_SERVER) break;
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
  } while (cursor);
  return out;
}

function formatMcpResult(result: unknown, maxBytes: number): string {
  if (!result || typeof result !== 'object') return truncate(String(result), maxBytes);
  const r = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string; mimeType?: string }>;
  };
  let body: string;
  if (!Array.isArray(r.content)) {
    body = JSON.stringify(result);
  } else {
    body = r.content
      .map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (part.type === 'image') {
          return `[image: ${part.mimeType ?? 'unknown'} — base64 omitted]`;
        }
        if (part.type === 'audio') {
          return `[audio: ${part.mimeType ?? 'unknown'} — base64 omitted]`;
        }
        if (part.type === 'resource') {
          return `[resource: omitted]`;
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }
  if (r.isError) {
    body = `[MCP server reported isError=true]\n${body}`;
  }
  return truncate(body, maxBytes);
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf-8') <= maxBytes) return s;
  // 简单按 chars 截断（粗略，避免 surrogate 撕碎）
  const approxChars = Math.floor(maxBytes / 3);
  return s.slice(0, approxChars) + `\n...[truncated at ~${maxBytes} bytes]`;
}

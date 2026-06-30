import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin, isPlatformAdmin } from '../auth/middleware.js';
import type { UserStore } from '../data/users/store.js';
import type { ManagedMcpServer, McpConfigStore, McpRiskLevel, McpSecretScope, McpSecretTarget } from '../data/mcpConfig.js';
import { GLOBAL_TENANT_ID, isSafeMcpServerId, isServerVisibleToTenant, isServerVisibleToUser } from '../data/mcpConfig.js';
import { GLOBAL_OWNER_ID, tenantOwnerId } from '../security/secretVault.js';
import type { McpClientManager, McpToolDescriptor } from '../mcp/clientManager.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { auditLog } from '../data/login-logs/index.js';
import type { SecretVault } from '../security/secretVault.js';

export interface McpRouterDeps {
  store: McpConfigStore;
  userStore: UserStore;
  manager: McpClientManager;
  agentCwd: string;
  secretVault?: SecretVault;
}

const riskSchema = z.enum(['read_only', 'workspace_write', 'external_write', 'credentialed_external_write'] satisfies [McpRiskLevel, ...McpRiskLevel[]]);
const secretScopeSchema = z.enum(['user', 'tenant', 'global'] satisfies [McpSecretScope, ...McpSecretScope[]]);
const secretTargetSchema = z.enum(['env', 'header'] satisfies [McpSecretTarget, ...McpSecretTarget[]]);

const secretRequirementSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
  label: z.string().min(1).max(120),
  target: secretTargetSchema,
  name: z.string().min(1).max(120),
  scope: secretScopeSchema,
  required: z.boolean().optional(),
  prefix: z.string().max(80).optional(),
  instructions: z.string().max(1000).optional(),
}).strict();

const stdioSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(1000)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  envSecretRefs: z.record(z.string(), z.string()).optional(),
}).passthrough();

const httpSchema = z.object({
  type: z.union([z.literal('http'), z.literal('streamable-http')]),
  url: z.string().url().max(2000),
  headers: z.record(z.string(), z.string()).optional(),
  headerSecretRefs: z.record(z.string(), z.union([
    z.string(),
    z.object({ ref: z.string().min(1), prefix: z.string().optional() }).strict(),
  ])).optional(),
}).passthrough();

/**
 * tenantId 字段：'*' = 全局 server（仅平台 admin 可写）；其他值 = 组织 slug
 * （仅平台 admin 可写跨组织；组织 admin 强制绑到 own）。
 * 入参为 optional：业务层根据 caller 身份强制覆盖（见 resolveTenantIdForCreate）。
 */
const tenantIdSchema = z.string().min(1).max(64).regex(/^(\*|[a-z][a-z0-9-]{0,63})$/, "tenantId must be '*' or a tenant slug");

const serverSchema = z.object({
  id: z.string().min(1).max(64).refine(isSafeMcpServerId, 'Use letters/digits/_/- and do not include __'),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  enabledByDefault: z.boolean().optional(),
  riskLevel: riskSchema.optional(),
  secretRequirements: z.array(secretRequirementSchema).max(20).optional(),
  createdFromTemplateId: z.string().max(120).optional(),
  createdFromTemplateVersion: z.number().int().positive().optional(),
  config: z.union([stdioSchema, httpSchema]),
  tenantId: tenantIdSchema.optional(),
  ownerUsername: z.string().min(1).max(80).optional(),
}).strict();

const myServerSchema = serverSchema
  .omit({ tenantId: true, ownerUsername: true })
  .superRefine((value, ctx) => {
    if ('command' in value.config) {
      ctx.addIssue({ code: 'custom', path: ['config'], message: '个人 MCP 暂只支持 http / streamable-http，不支持 stdio command' });
    }
    for (const [index, req] of (value.secretRequirements ?? []).entries()) {
      if (req.scope !== 'user') {
        ctx.addIssue({ code: 'custom', path: ['secretRequirements', index, 'scope'], message: '个人 MCP secret 只能使用 user scope' });
      }
    }
  });

const selectionsSchema = z.object({
  enabledServers: z.array(z.string().min(1).max(64)).max(100),
}).strict();

const secretValueSchema = z.object({ value: z.string().min(1).max(20000) }).strict();

export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();
  const { store, userStore, manager, agentCwd, secretVault } = deps;

  function currentUsername(req: Request): string | null {
    return req.user?.username ?? null;
  }

  function currentTenantId(req: Request): string | null {
    return req.user?.tenantId ?? null;
  }

  /**
   * 序列化对该用户/组织可见的 server 视图（同组织 + 全局）。
   * 用于 /me 与 /admin/users/:username（admin 代查时按目标 user 的组织隔离）。
   */
  function serializeForUser(username: string, tenantId: string) {
    const enabled = new Set(store.getUserConfig(username).enabledServers);
    return {
      configVersion: store.getConfigVersion(),
      servers: store.listServersVisibleToUser(username, tenantId).map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        enabledByDefault: s.enabledByDefault === true,
        enabled: enabled.has(s.id),
        transport: 'command' in s.config ? 'stdio' : s.config.type,
        riskLevel: s.riskLevel,
        secretRequirements: store.getUserSecretStatuses(username, s.id),
        createdFromTemplateId: s.createdFromTemplateId,
        createdFromTemplateVersion: s.createdFromTemplateVersion,
        tenantId: s.tenantId,
        ownerUsername: s.ownerUsername,
        personal: s.ownerUsername === username,
        ...(s.ownerUsername === username ? { config: s.config } : {}),
      })),
    };
  }

  function sanitizeDiagnosticTools(tools: McpToolDescriptor[]) {
    return tools.map(t => ({
      serverName: t.serverName,
      toolName: t.toolName,
      description: t.description,
    }));
  }

  /**
   * 写权限：caller 是否可以创建/修改 tenantId === serverTenantId 的 server？
   *   - 平台 admin：全部允许（含 '*'）
   *   - 组织 admin：仅 serverTenantId === own
   */
  function canWriteServerForTenant(req: Request, serverTenantId: string): boolean {
    if (isPlatformAdmin(req.user)) return true;
    return serverTenantId === req.user?.tenantId;
  }

  /**
   * 解析 upsert 入参的 tenantId：
   *   - 已存在 server：默认沿用 existing.tenantId；如果入参指定了新 tenantId，
   *     仅平台 admin 可改；组织 admin 试图改归属返回 403
   *   - 新建 server：平台 admin 默认 own（kaiyan），可显式指定任意 tenantId 或 '*'；
   *     组织 admin 强制设为 own，无论入参传什么
   */
  function resolveTenantIdForUpsert(
    req: Request,
    existing: ManagedMcpServer | undefined,
    inputTenantId: string | undefined,
  ): { ok: true; tenantId: string } | { ok: false; status: number; error: string } {
    const callerTenantId = currentTenantId(req);
    if (!callerTenantId) return { ok: false, status: 401, error: 'Authentication required' };
    const platform = isPlatformAdmin(req.user);
    if (existing) {
      // 跨组织写防御：组织 admin 不能改非自己组织的 server
      if (!platform && existing.tenantId !== callerTenantId) {
        return { ok: false, status: 403, error: '跨组织访问被拒绝' };
      }
      // tenantId 改归属：仅平台 admin
      if (inputTenantId && inputTenantId !== existing.tenantId) {
        if (!platform) return { ok: false, status: 403, error: '仅平台 admin 可修改 tenantId' };
        return { ok: true, tenantId: inputTenantId };
      }
      return { ok: true, tenantId: existing.tenantId };
    }
    // 新建
    if (platform) {
      return { ok: true, tenantId: inputTenantId || callerTenantId };
    }
    // 组织 admin：忽略入参，强制 own，禁 '*'
    if (inputTenantId && inputTenantId !== callerTenantId) {
      return { ok: false, status: 403, error: '组织 admin 不能跨组织创建 server' };
    }
    return { ok: true, tenantId: callerTenantId };
  }

  /**
   * 跨组织访问目标用户（admin 代查/代改）：
   *   - 平台 admin：任意
   *   - 组织 admin：仅 target.tenantId === own
   * 返回的 user 或 422 由调用方处理。
   */
  function resolveTargetUser(req: Request, res: Response, username: string) {
    const user = userStore.findByUsername(username);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    if (!isPlatformAdmin(req.user) && user.tenantId !== req.user?.tenantId) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return null;
    }
    return user;
  }

  router.get('/templates', (_req, res) => {
    res.json({ templates: store.listTemplates() });
  });

  router.get('/me', (req, res) => {
    const username = currentUsername(req);
    const tenantId = currentTenantId(req);
    if (!username || !tenantId) return res.status(401).json({ error: 'Authentication required' });
    res.json(serializeForUser(username, tenantId));
  });

  router.put('/me/selections', async (req, res) => {
    const username = currentUsername(req);
    const tenantId = currentTenantId(req);
    if (!username || !tenantId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = selectionsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid selections', details: parsed.error.format() });
    // setUserEnabledServers 内部按 tenantId 过滤掉不可见 server——
    // 即使前端绕过 UI 直发 API 也无法启用其他组织的 server。
    await store.setUserEnabledServers(username, parsed.data.enabledServers, tenantId);
    await manager.invalidateUser(username);
    auditLog(req, 'mcp_user_selections_updated', username);
    res.json({ ok: true });
  });

  router.put('/me/servers/:serverId/secrets/:key', async (req, res) => {
    const username = currentUsername(req);
    const tenantId = currentTenantId(req);
    if (!username || !tenantId || !req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!secretVault) return res.status(501).json({ error: 'Secret vault is not configured' });
    const parsed = secretValueSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid secret value', details: parsed.error.format() });
    const serverId = req.params.serverId;
    const key = req.params.key;
    // 跨组织可见性防御：绑 secret 前确认 server 对当前 user 可见
    const server = store.getServer(serverId);
    if (!server || !isServerVisibleToUser(server, username, tenantId)) {
      return res.status(404).json({ error: 'MCP server not found' });
    }
    const statuses = store.getUserSecretStatuses(username, serverId);
    const requirement = statuses.find(s => s.key === key);
    if (!requirement) return res.status(404).json({ error: 'Secret requirement not found' });
    // 严格 scope 校验：/me 端点仅接受 user-scope；tenant/global scope 必须走 /admin
    // 修复历史 silent bug：之前对任意 scope 都把值写到 user 命名空间，但读侧
    // 按 requirement.scope 选 ref source（user → userRefs，tenant/global → serverRefs），
    // 导致 tenant/global requirement 的用户写入永远读不到（silent no-op）。
    if (requirement.scope !== 'user') {
      return res.status(400).json({
        error: 'Use /admin/servers/:serverId/secrets/:key for tenant/global-scope secrets',
        details: { scope: requirement.scope },
      });
    }
    const ref = await secretVault.putSecret(username, 'mcp', parsed.data.value, {
      serverId,
      key,
      scope: requirement.scope,
      username,
    });
    await store.setUserSecretRef(username, serverId, key, ref.id);
    await manager.invalidateUser(username);
    auditLog(req, 'mcp_secret_bound', `${serverId}/${key}`);
    res.json({ ok: true, ref: { id: ref.id, updatedAt: ref.updatedAt, revokedAt: ref.revokedAt } });
  });

  router.post('/diagnose', async (req, res) => {
    const username = currentUsername(req);
    if (!username) return res.status(401).json({ error: 'Authentication required' });
    try {
      await manager.invalidateUser(username);
      const tools = await manager.ensureUser(username);
      res.json({ ok: true, tools: sanitizeDiagnosticTools(tools), toolCount: tools.length });
    } catch (err) {
      res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err), tools: [], toolCount: 0 });
    }
  });

  router.put('/me/servers/:id', async (req, res) => {
    const username = currentUsername(req);
    const tenantId = currentTenantId(req);
    if (!username || !tenantId) return res.status(401).json({ error: 'Authentication required' });
    const id = req.params.id;
    const existing = store.getServer(id);
    if (existing && existing.ownerUsername !== username) {
      return res.status(409).json({ error: 'MCP server id already exists' });
    }
    const parsed = myServerSchema.safeParse({ ...req.body, id });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid personal MCP server', details: parsed.error.format() });
    try {
      const server = await store.upsertServer({ ...parsed.data, tenantId, ownerUsername: username });
      const current = store.getUserConfig(username).enabledServers;
      if (!current.includes(id)) await store.setUserEnabledServers(username, [...current, id], tenantId);
      await manager.invalidateUser(username);
      auditLog(req, 'mcp_server_updated', `personal ${id}`);
      res.json({ ok: true, server });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/me/servers/:id', async (req, res) => {
    const username = currentUsername(req);
    if (!username) return res.status(401).json({ error: 'Authentication required' });
    const existing = store.getServer(req.params.id);
    if (!existing || existing.ownerUsername !== username) return res.status(404).json({ error: 'MCP server not found' });
    await store.deleteServer(req.params.id);
    await manager.invalidateUser(username);
    auditLog(req, 'mcp_server_deleted', `personal ${req.params.id}`);
    res.json({ ok: true });
  });

  // 列出 admin 视野内可写/可读的 server：平台 admin 看全部；组织 admin 仅本组织 + 全局。
  // 全局 server 对组织 admin 只读（参考意义），写权限由 PUT/DELETE 业务层兜底。
  router.get('/admin/servers', requireAdmin, (req, res) => {
    const tenantId = currentTenantId(req);
    if (!tenantId) return res.status(401).json({ error: 'Authentication required' });
    const servers = isPlatformAdmin(req.user)
      ? store.listCatalogServers()
      : store.listServersVisibleToTenant(tenantId);
    res.json({ configVersion: store.getConfigVersion(), servers });
  });

  router.put('/admin/servers/:id', requireAdmin, async (req, res) => {
    const id = req.params.id;
    const parsed = serverSchema.safeParse({ ...req.body, id });
    if (!parsed.success) {
      const details = parsed.error.format();
      return res.status(400).json({ error: 'Invalid MCP server', details });
    }
    const existing = store.getServer(id);
    const decision = resolveTenantIdForUpsert(req, existing, parsed.data.tenantId);
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    try {
      const server = await store.upsertServer({ ...parsed.data, tenantId: decision.tenantId });
      await Promise.all(userStore.listAll().map(u => manager.invalidateUser(u.username)));
      auditLog(req, 'mcp_server_updated', id);
      res.json({ ok: true, server });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/admin/servers/:id', requireAdmin, async (req, res) => {
    const existing = store.getServer(req.params.id);
    if (!existing) return res.status(404).json({ error: 'MCP server not found' });
    if (!canWriteServerForTenant(req, existing.tenantId)) {
      return res.status(403).json({ error: '跨组织访问被拒绝' });
    }
    await store.deleteServer(req.params.id);
    await Promise.all(userStore.listAll().map(u => manager.invalidateUser(u.username)));
    auditLog(req, 'mcp_server_deleted', req.params.id);
    res.json({ ok: true });
  });

  router.get('/admin/users/:username', requireAdmin, (req, res) => {
    const user = resolveTargetUser(req, res, req.params.username);
    if (!user) return;
    res.json(serializeForUser(user.username, user.tenantId));
  });

  router.put('/admin/users/:username/selections', requireAdmin, async (req, res) => {
    const user = resolveTargetUser(req, res, req.params.username);
    if (!user) return;
    const parsed = selectionsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid selections', details: parsed.error.format() });
    // 按 target user 的组织过滤 enabledServers——admin 不能给目标用户启用跨组织 server
    await store.setUserEnabledServers(user.username, parsed.data.enabledServers, user.tenantId);
    await manager.invalidateUser(user.username);
    auditLog(req, 'mcp_admin_user_selections_updated', user.username);
    res.json({ ok: true });
  });

  /**
   * PUT /admin/servers/:serverId/secrets/:key — admin 配置 tenant/global scope secret
   * 权限：
   *   - secret requirement.scope === 'tenant' → caller 必须能写该 server
   *     （平台 admin 任意；组织 admin 仅 server.tenantId === own）
   *   - secret requirement.scope === 'global' → caller 必须是平台 admin
   *     且 server.tenantId === GLOBAL_TENANT_ID
   *   - secret requirement.scope === 'user' → 400（请用 /me/.../secrets/:key）
   */
  router.put('/admin/servers/:serverId/secrets/:key', requireAdmin, async (req, res) => {
    if (!secretVault) return res.status(501).json({ error: 'Secret vault is not configured' });
    const parsed = secretValueSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid secret value', details: parsed.error.format() });

    const serverId = req.params.serverId;
    const key = req.params.key;
    const server = store.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });
    const requirement = (server.secretRequirements ?? []).find(s => s.key === key);
    if (!requirement) return res.status(404).json({ error: 'Secret requirement not found' });

    // 写权限：必须能写该 server（与 PUT /admin/servers/:id 同口径）
    if (!canWriteServerForTenant(req, server.tenantId)) {
      return res.status(403).json({ error: '跨组织访问被拒绝' });
    }

    // 计算 ownerId 与 scope 校验
    let ownerId: string;
    if (requirement.scope === 'user') {
      return res.status(400).json({ error: 'Use /me/servers/:serverId/secrets/:key for user-scope secrets' });
    } else if (requirement.scope === 'tenant') {
      if (server.tenantId === GLOBAL_TENANT_ID) {
        return res.status(400).json({ error: 'tenant-scope secret on a global server is ambiguous; use scope=global instead' });
      }
      ownerId = tenantOwnerId(server.tenantId);
    } else {
      // 'global'
      if (!isPlatformAdmin(req.user)) {
        return res.status(403).json({ error: 'Only platform admin can configure global-scope secrets' });
      }
      if (server.tenantId !== GLOBAL_TENANT_ID) {
        return res.status(400).json({ error: 'global-scope secret requires server.tenantId === "*"' });
      }
      ownerId = GLOBAL_OWNER_ID;
    }

    const ref = await secretVault.putSecret(ownerId, 'mcp', parsed.data.value, {
      serverId,
      key,
      scope: requirement.scope,
      ownerId,
    });
    await store.setServerSecretRef(serverId, key, ref.id);
    await Promise.all(userStore.listAll().map(u => manager.invalidateUser(u.username)));
    auditLog(req, 'mcp_secret_bound', `admin ${serverId}/${key} scope=${requirement.scope}`);
    res.json({ ok: true, ref: { id: ref.id, updatedAt: ref.updatedAt, revokedAt: ref.revokedAt } });
  });

  router.post('/admin/users/:username/diagnose', requireAdmin, async (req, res) => {
    const user = resolveTargetUser(req, res, req.params.username);
    if (!user) return;
    const workspaceRoot = resolveUserCwd(agentCwd, { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId });
    try {
      await manager.invalidateUser(user.username);
      const tools = await manager.ensureUser(user.username);
      res.json({ ok: true, workspaceRoot, tools: sanitizeDiagnosticTools(tools), toolCount: tools.length });
    } catch (err) {
      res.status(200).json({ ok: false, workspaceRoot, error: err instanceof Error ? err.message : String(err), tools: [], toolCount: 0 });
    }
  });

  return router;
}

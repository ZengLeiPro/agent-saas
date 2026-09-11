from pathlib import Path
import re
root = Path('server/src')
def put(path, text):
    p=root/path; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text.lstrip('\n'))
def change(path, before, after):
    p=root/path; s=p.read_text(); assert before in s,(path,before); p.write_text(s.replace(before,after,1))
change('app/models.ts', "responses_transport?: 'openai_compatible' | 'codex_subscription';", "responses_transport?: 'openai_compatible' | 'codex_subscription' | 'grok_subscription';")
# The shared HTTP helper can carry a local-only cleanup warning without changing existing callers.
p=root/'config/adminConfigMutationHttp.ts';s=p.read_text();a=s.index('export function sendConfigMutationError(')
s=s[:a]+s[a:].replace('res: Response, error: unknown): void {', 'res: Response, error: unknown, details: { warning?: string } = {}): void {',1).replace('.json({', '.json({ ...details,')
p.write_text(s)
# Exact per-operation field authority, including only the default needed for first registration.
p=root/'config/adminConfigOperationRegistry.ts';s=p.read_text();s=s.replace("  | 'codex.disconnect';", "  | 'codex.disconnect'\n  | 'grok.settings'\n  | 'grok.order'\n  | 'grok.complete'\n  | 'grok.remove'\n  | 'grok.disconnect';",1)
needle="    case 'codex.settings':";assert needle in s
s=s.replace(needle, '''    case 'grok.settings':
      return [['grokSubscription', 'enabled'], ['grokSubscription', 'quotaCooldownMinutes'], ['grokSubscription', 'oauthClientId']];
    case 'grok.order':
      return [['grokSubscription', 'credentialRef'], ['grokSubscription', 'credentialRefs']];
    case 'grok.complete':
      return [['grokSubscription', 'enabled'], ['grokSubscription', 'quotaCooldownMinutes'], ['grokSubscription', 'credentialRef'], ['grokSubscription', 'credentialRefs']];
    case 'grok.remove':
    case 'grok.disconnect':
      return [['grokSubscription', 'enabled'], ['grokSubscription', 'credentialRef'], ['grokSubscription', 'credentialRefs']];
''' + needle,1);p.write_text(s)
put('routes/grokSubscriptionAdminSupport.ts', '''import type { Request, Response } from 'express';
import { applyEdits, modify } from 'jsonc-parser';
import { ZodError } from 'zod';
import { getAppConfigPath, parseAppConfig, type AppConfig } from '../app/config.js';
import { AdminConfigMutationService, ConfigConflictError, ConfigMutationCommittedError, ProductionConfigPublishRequiredError, ProductionConfirmationError, RuntimeRestoreFailedError } from '../config/adminConfigMutationService.js';
import { AdminConfigOperationConflictError, AdminConfigOperationPendingError } from '../config/adminConfigOperationJournal.js';
import { adminConfigReadMetadata, mutationBusinessBody, mutationRequestContext, sendConfigMutationError } from '../config/adminConfigMutationHttp.js';
import { assertAdminConfigOperationScope, type AdminConfigOperationId } from '../config/adminConfigOperationRegistry.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import { GrokCredentialError, type GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokProtocolError, isRecord } from '../runtime/responses/grokProtocol.js';
import type { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import type { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';
import { orderedCredentialRefs } from '../runtime/responses/subscriptionAccountBinding.js';
export interface GrokSubscriptionAdminOptions {
  processCwd: string; config: AppConfig; credentialManager: GrokCredentialManager;
  deviceAuthService: GrokDeviceAuthService; modelCatalog?: GrokModelCatalogService;
  configMutationService?: AdminConfigMutationService; completionTaskLimit?: number; completionTaskTtlMs?: number;
}
export class GrokAdminInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'GROK_INVALID_REQUEST') { super(message); }
}
export function grokAdminOwner(req: Request): string {
  const owner = req.user?.sub ?? req.user?.username;
  if (!owner) throw new GrokAdminInputError('缺少平台管理员身份', 403);
  return owner;
}
export function grokAdminBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  if (req.body !== undefined && (!isRecord(req.body))) throw new GrokAdminInputError('请求正文必须是对象');
  const body = mutationBusinessBody(req);
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new GrokAdminInputError('请求包含不允许的字段');
  return body;
}
export function refsFromRaw(current: Record<string, unknown>): string[] {
  return orderedCredentialRefs({ credentialRef: typeof current.credentialRef === 'string' ? current.credentialRef : undefined,
    credentialRefs: Array.isArray(current.credentialRefs) ? current.credentialRefs.filter((ref): ref is string => typeof ref === 'string') : undefined });
}
export function withGrokRefs(current: Record<string, unknown>, refs: string[], enabled?: boolean): Record<string, unknown> {
  const next = { ...current }; delete next.credentialRef; delete next.credentialRefs;
  if (refs.length) { next.credentialRef = refs[0]; next.credentialRefs = refs; }
  if (enabled !== undefined) next.enabled = enabled;
  return next;
}
export function createGrokAdminContext(options: GrokSubscriptionAdminOptions) {
  const service = options.configMutationService ?? new AdminConfigMutationService({
    configPath: getAppConfigPath(options.processCwd), processCwd: options.processCwd,
    environment: readRuntimeIdentity().environment, processRole: 'all',
  });
  const assertWritable = () => { if (!service.getWritePolicy().canSave) throw new ProductionConfigPublishRequiredError(); };
  const publicState = async () => {
    const config = options.credentialManager.getConfiguration(); const credentials = await options.credentialManager.getStatuses();
    return { ...adminConfigReadMetadata(options.processCwd, service),
      config: { enabled: config.enabled, quotaCooldownMinutes: config.quotaCooldownMinutes, endpoint: config.endpoint,
        oauthClientId: config.oauthClientId, credentialCount: credentials.length },
      credentials, credential: credentials[0] ?? { configured: false, connected: false },
      runtime: options.credentialManager.getRuntimeStatus(), capabilities: { websocket: false, modelCatalog: true } };
  };
  const mutate = (req: Request, operation: Extract<AdminConfigOperationId, `grok.${string}`>,
    build: (current: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
    operationId?: string) => {
    assertWritable(); const requestContext = mutationRequestContext(req);
    return service.mutate({ ...requestContext, ...(operationId ? { operationId } : {}), operation: { id: operation }, changedPaths: ['grokSubscription'],
      buildCandidate: async (text, raw) => {
        const current = isRecord(raw.grokSubscription) ? raw.grokSubscription : {};
        const next = await build(current); const nextRaw = { ...raw, grokSubscription: next };
        parseAppConfig(nextRaw); assertAdminConfigOperationScope({ id: operation }, raw, nextRaw);
        // Persist only the requested raw fields, never unrelated Zod defaults.
        return applyEdits(text, modify(text, ['grokSubscription'], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      },
      applyRuntime: (candidate) => {
        // A failed first registration may legitimately roll back to an absent optional root.
        if (candidate.grokSubscription) options.config.grokSubscription = candidate.grokSubscription;
        else delete options.config.grokSubscription;
        options.modelCatalog?.invalidate();
      },
    });
  };
  return { options, service, assertWritable, publicState, mutate };
}
export type GrokAdminContext = ReturnType<typeof createGrokAdminContext>;
export function sendGrokAdminError(res: Response, error: unknown, warning?: string): void {
  if (error instanceof GrokAdminInputError) { res.status(error.status).json({ code: error.code, error: error.message, ...(warning ? { warning } : {}) }); return; }
  if (error instanceof ZodError) { res.status(400).json({ code: 'GROK_INVALID_CONFIG', error: 'Grok 配置无效，请检查启停、冷却分钟数和账号列表', ...(warning ? { warning } : {}) }); return; }
  if (error instanceof GrokProtocolError || error instanceof GrokCredentialError) {
    const status = error instanceof GrokProtocolError && [400, 403, 404, 409, 410, 429].includes(error.status ?? 0) ? error.status! : 502;
    res.status(status).json({ code: error.code, error: `Grok 操作未完成：${error.code}`, ...(warning ? { warning } : {}) }); return;
  }
  if (error instanceof ConfigMutationCommittedError || error instanceof RuntimeRestoreFailedError) {
    res.status(500).json({ code: error.code, error: 'Grok 配置可能已提交或仍需运行态恢复，请刷新状态并使用原操作重试；未清理可能生效的凭据。', ...(warning ? { warning } : {}) }); return;
  }
  if (error instanceof ConfigConflictError || error instanceof ProductionConfigPublishRequiredError || error instanceof ProductionConfirmationError
      || error instanceof AdminConfigOperationConflictError || error instanceof AdminConfigOperationPendingError) {
    sendConfigMutationError(res, error, warning ? { warning } : {}); return;
  }
  res.status(500).json({ code: 'GROK_ADMIN_OPERATION_FAILED', error: 'Grok 操作失败，请检查配置发布和凭据存储状态', ...(warning ? { warning } : {}) });
}
''')
put('routes/grokSubscriptionCompletion.ts', '''import type { Request, Response } from 'express';
import { ConfigMutationCommittedError, RuntimeRestoreFailedError } from '../config/adminConfigMutationService.js';
import { mutationRequestContext } from '../config/adminConfigMutationHttp.js';
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import { GrokAdminInputError, grokAdminBody, grokAdminOwner, refsFromRaw, sendGrokAdminError, withGrokRefs, type GrokAdminContext } from './grokSubscriptionAdminSupport.js';
type CompletionState = Awaited<ReturnType<GrokAdminContext['publicState']>> & { status: 'applied'; warning?: string };
interface CompletionTask { promise: Promise<CompletionState>; settled: boolean; createdAt: number; timer?: ReturnType<typeof setTimeout> }
/** The map only coalesces a live request. Durable production idempotency belongs to the operation journal. */
export class GrokSubscriptionCompletion {
  private readonly tasks = new Map<string, CompletionTask>();
  constructor(private readonly context: GrokAdminContext) {}
  isPending(sessionId: string, owner: string): boolean { return this.tasks.get(this.key(sessionId, owner))?.settled === false; }
  async handle(req: Request, res: Response): Promise<void> {
    let candidateRef: string | undefined;
    try {
      this.context.assertWritable(); grokAdminBody(req, []);
      const sessionId = req.params.sessionId; const owner = grokAdminOwner(req); const key = this.key(sessionId, owner);
      const existing = this.tasks.get(key); if (existing) { res.json(await existing.promise); return; }
      this.reserveSlot();
      const promise = this.complete(req, sessionId, owner, (ref) => { candidateRef = ref; });
      const task: CompletionTask = { promise, settled: false, createdAt: Date.now() }; this.tasks.set(key, task);
      void promise.then(() => {
        task.settled = true;
        task.timer = setTimeout(() => { if (this.tasks.get(key) === task) this.tasks.delete(key); }, this.context.options.completionTaskTtlMs ?? 300_000);
        task.timer.unref?.();
      }, () => { if (this.tasks.get(key) === task) this.tasks.delete(key); });
      res.json(await promise);
    } catch (error) {
      let warning: string | undefined;
      if (candidateRef && !(error instanceof ConfigMutationCommittedError) && !(error instanceof RuntimeRestoreFailedError)) {
        try { await this.context.options.credentialManager.discardLoginCandidate(candidateRef); }
        catch { warning = '未发布候选凭据的本地清理未确认，请检查 SecretVault；未尝试远端撤销授权 grant。'; }
      }
      sendGrokAdminError(res, error, warning);
    }
  }
  private async complete(req: Request, sessionId: string, owner: string, onCandidate: (ref: string) => void): Promise<CompletionState> {
    const { options } = this.context;
    try {
      if (options.deviceAuthService.status(sessionId, owner).status === 'applied') return { ...await this.context.publicState(), status: 'applied' };
    } catch (error) {
      // A known durable operation may be replayed after an API restart. The journal, not this
      // missing in-memory session, determines whether the already-committed operation succeeded.
      if (!(error instanceof GrokProtocolError && error.code === 'authorization_not_found')) throw error;
    }
    const operationId = mutationRequestContext(req).operationId ?? sessionId;
    let replacedRef: string | undefined;
    const result = await this.context.mutate(req, 'grok.complete', async (current) => {
      const authorized = options.deviceAuthService.authorizedResult(sessionId, owner);
      const refs = refsFromRaw(current); replacedRef = authorized.replaceCredentialRef;
      if (replacedRef && !refs.includes(replacedRef)) throw new GrokAdminInputError('待重授权账号已被移除，请重新开始授权', 409);
      if (!replacedRef && refs.length >= 100) throw new GrokAdminInputError('Grok 账号数量已达到上限', 409);
      await options.credentialManager.assertUniqueAccount(authorized.tokens, refs, replacedRef);
      const candidate = await options.credentialManager.persistLogin(authorized.tokens, undefined, {
        configOperationId: operationId, ...(replacedRef ? { replacesCredentialRef: replacedRef } : {}),
      });
      onCandidate(candidate.credentialRef);
      const nextRefs = replacedRef ? refs.map((ref) => ref === replacedRef ? candidate.credentialRef : ref) : [...refs, candidate.credentialRef];
      return { ...withGrokRefs(current, nextRefs, true), quotaCooldownMinutes: current.quotaCooldownMinutes ?? 60 };
    }, operationId);
    try { options.deviceAuthService.complete(sessionId, owner); }
    catch (error) { if (!(error instanceof GrokProtocolError && error.code === 'authorization_not_found')) throw new ConfigMutationCommittedError(error); }
    let warning: string | undefined;
    if (replacedRef) {
      try { await options.credentialManager.revoke(replacedRef, false); }
      catch { warning = '新账号凭据已登记，旧凭据的本地清理未确认；未远端撤销可能共享的授权 grant。'; }
    }
    return { ...await this.context.publicState(), revision: result.revision, status: 'applied', ...(warning ? { warning } : {}) };
  }
  private key(sessionId: string, owner: string): string { return `${owner}\\0${sessionId}`; }
  private reserveSlot(): void {
    if (this.tasks.size < (this.context.options.completionTaskLimit ?? 100)) return;
    const oldest = [...this.tasks].filter(([, task]) => task.settled).sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) throw new GrokAdminInputError('正在登记的 Grok 授权过多，请稍后重试', 429);
    if (oldest[1].timer) clearTimeout(oldest[1].timer); this.tasks.delete(oldest[0]);
  }
}
''')
put('routes/grokSubscriptionAdmin.ts', '''import { Router } from 'express';
import { requirePlatformAdmin } from '../auth/middleware.js';
import { GrokSubscriptionCompletion } from './grokSubscriptionCompletion.js';
import { createGrokAdminContext, GrokAdminInputError, grokAdminBody, grokAdminOwner, refsFromRaw, sendGrokAdminError, withGrokRefs, type GrokSubscriptionAdminOptions } from './grokSubscriptionAdminSupport.js';
export type { GrokSubscriptionAdminOptions } from './grokSubscriptionAdminSupport.js';
export function createGrokSubscriptionAdminRouter(options: GrokSubscriptionAdminOptions): Router {
  const router = Router(); const context = createGrokAdminContext(options); const completion = new GrokSubscriptionCompletion(context);
  router.use(requirePlatformAdmin);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (_req, res) => {
    try { res.json(await context.publicState()); } catch (error) { sendGrokAdminError(res, error); }
  });
  router.put('/', async (req, res) => {
    try {
      const body = grokAdminBody(req, ['enabled', 'quotaCooldownMinutes', 'oauthClientId']);
      if ('enabled' in body && typeof body.enabled !== 'boolean') throw new GrokAdminInputError('enabled 必须是布尔值');
      if ('quotaCooldownMinutes' in body && (typeof body.quotaCooldownMinutes !== 'number' || !Number.isInteger(body.quotaCooldownMinutes) || body.quotaCooldownMinutes < 1 || body.quotaCooldownMinutes > 10_080)) throw new GrokAdminInputError('冷却时间必须是 1 到 10080 之间的整数分钟');
      if ('oauthClientId' in body && (typeof body.oauthClientId !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(body.oauthClientId))) throw new GrokAdminInputError('OAuth client ID 无效');
      await context.mutate(req, 'grok.settings', (current) => {
        const next = { ...current, ...body, enabled: body.enabled ?? current.enabled ?? false, quotaCooldownMinutes: body.quotaCooldownMinutes ?? current.quotaCooldownMinutes ?? 60 };
        if (next.enabled === true && refsFromRaw(current).length === 0) throw new GrokAdminInputError('请先完成至少一个 Grok 账号授权，再启用订阅', 409);
        return next;
      }); res.json(await context.publicState());
    } catch (error) { sendGrokAdminError(res, error); }
  });
  router.put('/credentials/order', async (req, res) => {
    try {
      const body = grokAdminBody(req, ['credentialRefs']); const requested = body.credentialRefs;
      if (!Array.isArray(requested) || requested.some((ref) => typeof ref !== 'string') || requested.length === 0) throw new GrokAdminInputError('请提交完整的账号优先级列表');
      await context.mutate(req, 'grok.order', (current) => {
        const refs = refsFromRaw(current); const set = new Set(requested);
        if (refs.length !== requested.length || set.size !== refs.length || refs.some((ref) => !set.has(ref))) throw new GrokAdminInputError('账号列表已变化或存在重复、缺失、未知账号，请刷新后重试', 409);
        return withGrokRefs(current, requested as string[]);
      }); res.json(await context.publicState());
    } catch (error) { sendGrokAdminError(res, error); }
  });
  router.post('/device/start', async (req, res) => {
    try {
      context.assertWritable(); const body = grokAdminBody(req, ['credentialRef']);
      if ('credentialRef' in body && (typeof body.credentialRef !== 'string' || !body.credentialRef)) throw new GrokAdminInputError('credentialRef 无效');
      const replaceRef = typeof body.credentialRef === 'string' ? body.credentialRef : undefined;
      if (replaceRef && !options.credentialManager.getCredentialRefs().includes(replaceRef)) throw new GrokAdminInputError('待重授权账号不存在', 404);
      res.status(201).json(await options.deviceAuthService.start(grokAdminOwner(req), replaceRef, options.credentialManager.getConfiguration().oauthClientId));
    } catch (error) { sendGrokAdminError(res, error); }
  });
  router.get('/device/:sessionId', (req, res) => {
    try { const result = options.deviceAuthService.status(req.params.sessionId, grokAdminOwner(req)); res.status(result.status === 'expired' ? 410 : 200).json(result); }
    catch (error) { sendGrokAdminError(res, error); }
  });
  router.post('/device/:sessionId/poll', async (req, res) => {
    try {
      context.assertWritable(); grokAdminBody(req, []);
      const result = await options.deviceAuthService.poll(req.params.sessionId, grokAdminOwner(req));
      res.status(result.status === 'expired' ? 410 : 200).json(result);
    } catch (error) { sendGrokAdminError(res, error); }
  });
  router.post('/device/:sessionId/complete', (req, res) => completion.handle(req, res));
  router.delete('/device/:sessionId', (req, res) => {
    try {
      const owner = grokAdminOwner(req); grokAdminBody(req, []);
      if (completion.isPending(req.params.sessionId, owner)) throw new GrokAdminInputError('该授权正在登记，请先刷新登记结果', 409);
      options.deviceAuthService.cancel(req.params.sessionId, owner); res.json({ status: 'cancelled' });
    } catch (error) { sendGrokAdminError(res, error); }
  });
  router.delete('/credentials/:credentialRef', async (req, res) => {
    try {
      grokAdminBody(req, []); const ref = req.params.credentialRef;
      await context.mutate(req, 'grok.remove', (current) => {
        const refs = refsFromRaw(current); if (!refs.includes(ref)) throw new GrokAdminInputError('Grok 账号不存在', 404);
        const next = refs.filter((entry) => entry !== ref); return withGrokRefs(current, next, next.length ? current.enabled === true : false);
      });
      let warning: string | undefined;
      try { warning = (await options.credentialManager.revoke(ref)).remoteWarning; }
      catch { warning = '账号已从运行配置移除，但凭据清理未确认，请检查 SecretVault。'; }
      res.json({ ...await context.publicState(), ...(warning ? { warning } : {}) });
    } catch (error) { sendGrokAdminError(res, error); }
  });
  router.delete('/', async (req, res) => {
    try {
      grokAdminBody(req, []); let removed: string[] = [];
      await context.mutate(req, 'grok.disconnect', (current) => { removed = refsFromRaw(current); return withGrokRefs(current, [], false); });
      const warnings: string[] = [];
      for (const ref of removed) {
        try { const { remoteWarning } = await options.credentialManager.revoke(ref); if (remoteWarning) warnings.push(remoteWarning); }
        catch { warnings.push('部分凭据清理未确认，请检查 SecretVault。'); }
      }
      res.json({ ...await context.publicState(), ...(warnings.length ? { warning: [...new Set(warnings)].join('；') } : {}) });
    } catch (error) { sendGrokAdminError(res, error); }
  });
  // Unlike the metadata GET, this explicit collection endpoint may refresh credentials through the shared manager.
  router.get('/models', async (req, res) => {
    try {
      if (!options.modelCatalog) throw new GrokAdminInputError('订阅模型目录服务未装配', 503);
      res.json(await options.modelCatalog.list(req.query.refresh === 'true'));
    } catch (error) { sendGrokAdminError(res, error); }
  });
  return router;
}
''')
# Assemble one provider manager/cache per process, with shared PG locks/state/journal across processes.
put('app/modelSubscriptionRuntime.ts', '''import type { AppConfig } from './config.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { SecretVault } from '../security/secretVault.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import { CodexCredentialManager, PgCodexCredentialLock } from '../runtime/responses/codexCredentialManager.js';
import { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';
import { createCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';
import { PgSubscriptionCredentialLock } from '../runtime/responses/subscriptionCredentialLock.js';
import { createSubscriptionCredentialRuntimeStateStore } from '../runtime/responses/subscriptionCredentialRuntimeState.js';
import { createGrokRefreshJournal } from '../runtime/responses/subscriptionRefreshJournal.js';
export async function createModelSubscriptionRuntime(options: { config: AppConfig; secretVault: SecretVault; pool?: PgEventStore['pool']; egressFetch: typeof fetch }) {
  const { config, secretVault, pool, egressFetch } = options;
  const codexCredentialManager = new CodexCredentialManager({ vault: secretVault, getConfig: () => config.codexSubscription,
    ...(pool ? { lock: new PgCodexCredentialLock(pool) } : {}),
    runtimeStateStore: await createCodexCredentialRuntimeStateStore(pool, config.runtimeEventStore), fetchImpl: egressFetch });
  const codexDeviceAuthService = new CodexDeviceAuthService(egressFetch);
  const oauthClient = new GrokOAuthClient(egressFetch);
  const grokCredentialManager = new GrokCredentialManager({ vault: secretVault, getConfig: () => config.grokSubscription,
    ...(pool ? { lock: new PgSubscriptionCredentialLock(pool) } : {}),
    runtimeStateStore: await createSubscriptionCredentialRuntimeStateStore(pool, config.runtimeEventStore, 'grok'),
    refreshJournal: await createGrokRefreshJournal(pool, config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined),
    oauthClient, requireRotationCoordinator: readRuntimeIdentity().environment === 'production' });
  const grokDeviceAuthService = new GrokDeviceAuthService(oauthClient);
  const grokModelCatalog = new GrokModelCatalogService(grokCredentialManager, egressFetch);
  return { codexCredentialManager, codexDeviceAuthService, grokCredentialManager, grokDeviceAuthService, grokModelCatalog,
    factoryDependencies: { codexCredentialManager, codexFetch: egressFetch, grokCredentialManager, grokFetch: egressFetch, grokModelCatalog } };
}
''')
p=root/'runtime/responses/grokCredentialManager.ts';s=p.read_text();needle='credentialRotationCoordinator?: (ref: string) => Promise<void>;';assert needle in s
s=s.replace(needle,needle+'\n    requireRotationCoordinator?: boolean;',1)
needle='      await this.journal.begin(ref, latest.generation);';assert needle in s
s=s.replace(needle,"      if (this.options.requireRotationCoordinator && !this.coordinator) throw new GrokProtocolError('credential_publication_unavailable');\n"+needle,1);p.write_text(s)
p=root/'app/runtime.ts';s=p.read_text();a=s.index('  const codexCredentialManager = new CodexCredentialManager({');b=s.index('  const memoryContextTools =',a)
s=s[:a]+'''  const subscriptionRuntime = await createModelSubscriptionRuntime({ config, secretVault, pool: pgEventStore?.pool, egressFetch });
  const { codexCredentialManager, codexDeviceAuthService, grokCredentialManager, grokDeviceAuthService, grokModelCatalog } = subscriptionRuntime;
  const titleModelAdapterFactory = createTitleModelAdapterFactory(codexCredentialManager, egressFetch, subscriptionRuntime.factoryDependencies);
'''+s[b:]
s="import { createModelSubscriptionRuntime } from './modelSubscriptionRuntime.js';\n"+s
# Remove only now-unused Codex construction imports, retaining any unrelated live exports.
s=re.sub(r"import \{ CodexCredentialManager, PgCodexCredentialLock \} from '../runtime/responses/codexCredentialManager.js';\n",'',s)
s=re.sub(r"import \{ CodexDeviceAuthService \} from '../runtime/responses/codexOAuth.js';\n",'',s)
s=re.sub(r"import \{ createCodexCredentialRuntimeStateStore \} from '../runtime/responses/codexCredentialRuntimeState.js';\n",'',s)
needle='{ codexCredentialManager, codexFetch: egressFetch, codexWebSocketPool }';assert needle in s
s=s.replace(needle,'{ ...subscriptionRuntime.factoryDependencies, codexWebSocketPool }',1)
needle='  codexCredentialManager.setCredentialRotationCoordinator(productionModelPublication?.coordinateCredentialRotation);';assert needle in s
s=s.replace(needle,needle+'\n  grokCredentialManager.setCredentialRotationCoordinator(productionModelPublication?.coordinateCredentialRotation);',1)
needle='    secretVault, codexCredentialManager, codexDeviceAuthService,';assert needle in s
s=s.replace(needle,needle+' grokCredentialManager, grokDeviceAuthService, grokModelCatalog,',1);p.write_text(s)
p=root/'app/titleGeneratorConfigs.ts';s=p.read_text();s="import type { ModelAdapterFactoryDependencies } from '../runtime/rawRuntimeRunDispatchTypes.js';\n"+s
s=s.replace('  codexFetch: typeof fetch,\n): ModelAdapterFactory {', "  codexFetch: typeof fetch,\n  subscriptionDependencies: Pick<ModelAdapterFactoryDependencies, 'grokCredentialManager' | 'grokFetch' | 'grokModelCatalog'> = {},\n): ModelAdapterFactory {",1)
s=s.replace('{ codexCredentialManager, codexFetch },','{ codexCredentialManager, codexFetch, ...subscriptionDependencies },',1);p.write_text(s)
p=root/'app/runtimeContracts.ts';s=p.read_text();s="import type { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';\nimport type { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';\nimport type { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';\n"+s
s=s.replace('  codexDeviceAuthService: CodexDeviceAuthService;', '  codexDeviceAuthService: CodexDeviceAuthService;\n  grokCredentialManager: GrokCredentialManager;\n  grokDeviceAuthService: GrokDeviceAuthService;\n  grokModelCatalog: GrokModelCatalogService;',1);p.write_text(s)
p=root/'app/modelProviderAdminRoutes.ts';s=p.read_text();s="import { createGrokSubscriptionAdminRouter } from '../routes/grokSubscriptionAdmin.js';\n"+s
needle="  app.use(\n    '/api/admin/provider-quota',";assert needle in s
s=s.replace(needle,"  app.use('/api/admin/grok-subscription', createGrokSubscriptionAdminRouter({ ...deps, credentialManager: runtime.grokCredentialManager, deviceAuthService: runtime.grokDeviceAuthService, modelCatalog: runtime.grokModelCatalog }));\n"+needle,1);p.write_text(s)
print('Applied Grok administrator lifecycle, strict operations, two-stage publication and shared runtime assembly')

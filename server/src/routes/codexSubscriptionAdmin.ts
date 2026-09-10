import { Router, type Request } from 'express';
import { applyEdits, modify } from 'jsonc-parser';

import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, CodexSubscriptionConfig } from '../app/config.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import type { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';
import {
  AdminConfigMutationService,
  ConfigMutationCommittedError,
  RuntimeRestoreFailedError,
} from '../config/adminConfigMutationService.js';
import {
  adminConfigReadMetadata,
  mutationRequestContext,
  sendConfigMutationError,
} from '../config/adminConfigMutationHttp.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';

export interface CreateCodexSubscriptionAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  credentialManager: CodexCredentialManager;
  deviceAuthService: CodexDeviceAuthService;
  closeWebSockets?: (credentialRefs?: readonly string[]) => void;
  configMutationService?: AdminConfigMutationService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function credentialRefs(options: CreateCodexSubscriptionAdminRouterOptions): string[] {
  return options.credentialManager.getCredentialRefs();
}

function configWithCredentialRefs(
  current: ReturnType<CodexCredentialManager['getConfiguration']>,
  refs: string[],
  overrides: Partial<Pick<CodexSubscriptionConfig, 'enabled' | 'websocketEnabled' | 'quotaCooldownMinutes'>> = {},
): CodexSubscriptionConfig {
  return {
    enabled: overrides.enabled ?? current.enabled,
    websocketEnabled: (overrides.websocketEnabled ?? current.websocketEnabled)
      && (overrides.enabled ?? current.enabled),
    quotaCooldownMinutes: overrides.quotaCooldownMinutes ?? current.quotaCooldownMinutes,
    endpoint: current.endpoint,
    originator: current.originator,
    ...(refs[0] ? { credentialRef: refs[0], credentialRefs: refs } : {}),
  };
}

async function persistConfig(
  options: CreateCodexSubscriptionAdminRouterOptions,
  configMutationService: AdminConfigMutationService,
  req: Request,
  next: CodexSubscriptionConfig,
  operation: 'codex.settings' | 'codex.order' | 'codex.complete' | 'codex.remove' | 'codex.disconnect',
): Promise<CodexSubscriptionConfig> {
  const result = await configMutationService.mutate({
    ...mutationRequestContext(req),
    operation: { id: operation },
    changedPaths: ['codexSubscription'],
    buildCandidate: (configText, raw) => {
      const parsed = parseAppConfig({ ...raw, codexSubscription: next });
      if (!parsed.codexSubscription) throw new Error('codexSubscription 配置无效');
      return applyEdits(configText, modify(configText, ['codexSubscription'], parsed.codexSubscription, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
    },
    applyRuntime: (candidate) => {
      if (!candidate.codexSubscription) throw new Error('codexSubscription 配置无效');
      const previous = options.credentialManager.getConfiguration();
      options.config.codexSubscription = candidate.codexSubscription;
      const invalidation = webSocketInvalidation(previous, candidate.codexSubscription);
      if (invalidation === 'all') options.closeWebSockets?.();
      else if (invalidation.length > 0) options.closeWebSockets?.(invalidation);
    },
  });
  return result.config.codexSubscription!;
}

async function publicState(
  options: CreateCodexSubscriptionAdminRouterOptions,
  service?: AdminConfigMutationService,
) {
  const configuration = options.credentialManager.getConfiguration();
  const credentials = await options.credentialManager.getStatuses();
  return {
    ...(service ? adminConfigReadMetadata(options.processCwd, service) : {}),
    config: {
      enabled: configuration.enabled,
      websocketEnabled: configuration.websocketEnabled,
      quotaCooldownMinutes: configuration.quotaCooldownMinutes,
      endpoint: configuration.endpoint,
      originator: configuration.originator,
      credentialCount: credentials.length,
    },
    // credential 保留为旧前端兼容别名；新的管理界面使用 credentials 排序操作。
    credential: credentials[0] ?? { configured: false, connected: false },
    credentials,
    runtime: options.credentialManager.getRuntimeStatus(),
  };
}

export function createCodexSubscriptionAdminRouter(
  options: CreateCodexSubscriptionAdminRouterOptions,
): Router {
  const router = Router();
  const deviceCompletionTasks = new Map<
    string,
    Promise<Awaited<ReturnType<typeof publicState>>>
  >();
  const configMutationService = options.configMutationService ?? new AdminConfigMutationService({
    configPath: getAppConfigPath(options.processCwd),
    processCwd: options.processCwd,
    environment: readRuntimeIdentity().environment,
    processRole: 'all',
  });
  router.use(requirePlatformAdmin);

  router.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await publicState(options, configMutationService));
  });

  router.put('/', async (req, res) => {
    const current = options.credentialManager.getConfiguration();
    const refs = credentialRefs(options);
    const body = isRecord(req.body) ? req.body : {};
    const requestedQuotaCooldownMinutes = body.quotaCooldownMinutes;
    if ('quotaCooldownMinutes' in body && typeof requestedQuotaCooldownMinutes !== 'number') {
      res.status(400).json({ error: 'quotaCooldownMinutes 必须是数字' });
      return;
    }
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : current.enabled;
    const requestedWebsocketEnabled = typeof body.websocketEnabled === 'boolean'
      ? body.websocketEnabled
      : current.websocketEnabled;
    const quotaCooldownMinutes = typeof requestedQuotaCooldownMinutes === 'number'
      ? requestedQuotaCooldownMinutes
      : current.quotaCooldownMinutes;
    if (!Number.isInteger(quotaCooldownMinutes) || quotaCooldownMinutes < 1 || quotaCooldownMinutes > 10_080) {
      res.status(400).json({ error: 'quotaCooldownMinutes 必须是 1 到 10080 之间的整数' });
      return;
    }
    if (enabled && refs.length === 0) {
      res.status(409).json({ error: '请先完成至少一个 Codex 账号授权，再启用订阅 transport' });
      return;
    }

    try {
      await persistConfig(options, configMutationService, req, configWithCredentialRefs(current, refs, {
        enabled,
        websocketEnabled: requestedWebsocketEnabled,
        quotaCooldownMinutes,
      }), 'codex.settings');
      res.json(await publicState(options, configMutationService));
    } catch (error) {
      sendConfigMutationError(res, error);
    }
  });

  router.put('/credentials/order', async (req, res) => {
    const current = options.credentialManager.getConfiguration();
    const currentRefs = credentialRefs(options);
    const body = isRecord(req.body) ? req.body : {};
    const requested = Array.isArray(body.credentialRefs)
      ? body.credentialRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
      : [];
    const requestedSet = new Set(requested);
    if (
      requested.length !== currentRefs.length
      || requestedSet.size !== currentRefs.length
      || currentRefs.some((ref) => !requestedSet.has(ref))
    ) {
      res.status(400).json({ error: '授权账号排序必须包含全部已配置账号，且不能重复' });
      return;
    }

    try {
      await persistConfig(options, configMutationService, req, configWithCredentialRefs(current, requested), 'codex.order');
      res.json(await publicState(options, configMutationService));
    } catch (error) {
      sendConfigMutationError(res, error);
    }
  });

  router.post('/device/start', async (req, res) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const replaceCredentialRef = typeof body.credentialRef === 'string'
        ? body.credentialRef.trim()
        : '';
      if (replaceCredentialRef && !credentialRefs(options).includes(replaceCredentialRef)) {
        res.status(404).json({ error: '待重授权的 Codex 账号不存在' });
        return;
      }
      const session = await options.deviceAuthService.start(
        replaceCredentialRef ? { replaceCredentialRef } : undefined,
      );
      res.status(201).json(session);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/device/:sessionId', async (req, res) => {
    try {
      const existingCompletion = deviceCompletionTasks.get(req.params.sessionId);
      if (existingCompletion) {
        res.json({ status: 'applied', ...(await existingCompletion) });
        return;
      }
      const result = options.deviceAuthService.status(req.params.sessionId);
      res.status(result.status === 'expired' ? 410 : 200).json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/device/:sessionId/poll', async (req, res) => {
    try {
      const result = await options.deviceAuthService.poll(req.params.sessionId);
      if (result.status === 'completed') {
        res.json({
          status: 'authorized_pending_publication',
          ...(result.replaceCredentialRef ? { replaceCredentialRef: result.replaceCredentialRef } : {}),
        });
        return;
      }
      res.status(result.status === 'expired' ? 410 : 200).json(result);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/device/:sessionId/complete', async (req, res) => {
    const prior = deviceCompletionTasks.get(req.params.sessionId);
    if (prior) {
      res.json({ status: 'applied', ...(await prior) });
      return;
    }
    let candidateRef: string | undefined;
    const completion = (async () => {
      const authorized = options.deviceAuthService.completedResult(req.params.sessionId);
      const requestContext = mutationRequestContext(req);
      const result = await configMutationService.mutate({
        ...requestContext,
        operation: { id: 'codex.complete' },
        changedPaths: ['codexSubscription'],
        buildCandidate: async (configText, raw) => {
          const persistedConfig = parseAppConfig(raw);
          const current = persistedConfig.codexSubscription;
          if (!current) throw new Error('codexSubscription 配置无效');
          const currentRefs = current.credentialRefs?.length
            ? [...current.credentialRefs]
            : current.credentialRef ? [current.credentialRef] : [];
          if (authorized.replaceCredentialRef && !currentRefs.includes(authorized.replaceCredentialRef)) {
            throw new Error('待重授权的 Codex 账号已被移除，请重新发起授权');
          }
          const candidate = await options.credentialManager.persistLogin(
            authorized.tokens,
            undefined,
            requestContext.operationId ? { configOperationId: requestContext.operationId } : {},
          );
          candidateRef = candidate.credentialRef;
          const nextRefs = authorized.replaceCredentialRef
            ? currentRefs.map((ref) => ref === authorized.replaceCredentialRef ? candidate.credentialRef : ref)
            : [...currentRefs, candidate.credentialRef];
          const next = {
            ...current,
            enabled: true,
            websocketEnabled: current.websocketEnabled === true,
            credentialRef: nextRefs[0],
            credentialRefs: nextRefs,
          };
          const parsed = parseAppConfig({ ...raw, codexSubscription: next });
          return applyEdits(configText, modify(configText, ['codexSubscription'], parsed.codexSubscription, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }));
        },
        applyRuntime: (candidate) => {
          if (!candidate.codexSubscription) throw new Error('codexSubscription 配置无效');
          options.config.codexSubscription = candidate.codexSubscription;
        },
      });
      if (authorized.replaceCredentialRef) options.closeWebSockets?.([authorized.replaceCredentialRef]);
      options.deviceAuthService.complete(req.params.sessionId);
      return { ...await publicState(options, configMutationService), revision: result.revision };
    })();
    deviceCompletionTasks.set(req.params.sessionId, completion);
    try {
      res.json({ status: 'applied', ...(await completion) });
    } catch (error) {
      deviceCompletionTasks.delete(req.params.sessionId);
      if (candidateRef && !(error instanceof RuntimeRestoreFailedError) && !(error instanceof ConfigMutationCommittedError)) {
        await options.credentialManager.discardLoginCandidate(candidateRef);
      }
      sendConfigMutationError(res, error);
    }
  });

  router.delete('/credentials/:credentialRef', async (req, res) => {
    const current = options.credentialManager.getConfiguration();
    const currentRefs = credentialRefs(options);
    const ref = req.params.credentialRef;
    if (!currentRefs.includes(ref)) {
      res.status(404).json({ error: 'Codex 授权账号不存在' });
      return;
    }
    const nextRefs = currentRefs.filter((item) => item !== ref);
    try {
      await persistConfig(options, configMutationService, req, configWithCredentialRefs(current, nextRefs, {
        enabled: nextRefs.length > 0 ? current.enabled : false,
        websocketEnabled: nextRefs.length > 0 ? current.websocketEnabled : false,
      }), 'codex.remove');
    } catch (error) {
      sendConfigMutationError(res, error);
      return;
    }

    let warning: string | undefined;
    try {
      warning = (await options.credentialManager.revoke(ref)).remoteWarning;
    } catch {
      warning = 'transport 已更新，但旧 SecretVault 凭据清理失败，请检查凭据存储';
    }
    res.json({
      ...(await publicState(options, configMutationService)),
      ...(warning ? { warning } : {}),
    });
  });

  router.delete('/', async (_req, res) => {
    const current = options.credentialManager.getConfiguration();
    const refs = credentialRefs(options);
    try {
      await persistConfig(options, configMutationService, _req, configWithCredentialRefs(current, [], {
        enabled: false,
        websocketEnabled: false,
      }), 'codex.disconnect');
    } catch (error) {
      sendConfigMutationError(res, error);
      return;
    }

    const warnings: string[] = [];
    for (const ref of refs) {
      try {
        const result = await options.credentialManager.revoke(ref);
        if (result.remoteWarning) warnings.push(result.remoteWarning);
      } catch {
        warnings.push('部分 SecretVault 凭据清理失败，请检查凭据存储');
      }
    }
    res.json({
      ...(await publicState(options, configMutationService)),
      ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
    });
  });

  return router;
}

function webSocketInvalidation(
  previous: ReturnType<CodexCredentialManager['getConfiguration']>,
  next: CodexSubscriptionConfig,
): 'all' | string[] {
  if (previous.enabled !== next.enabled || previous.websocketEnabled !== next.websocketEnabled) return 'all';
  if (previous.endpoint !== (next.endpoint ?? previous.endpoint)) return 'all';
  if (previous.originator !== (next.originator ?? previous.originator)) return 'all';
  const previousRefs = previous.credentialRefs;
  const nextRefs = next.credentialRefs ?? (next.credentialRef ? [next.credentialRef] : []);
  return [...new Set([...previousRefs, ...nextRefs])]
    .filter((ref) => previousRefs.includes(ref) !== nextRefs.includes(ref));
}

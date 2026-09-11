import type { Request, Response } from 'express';
import { applyEdits, modify } from 'jsonc-parser';
import { ZodError } from 'zod';
import { getAppConfigPath, parseAppConfig, type AppConfig } from '../app/config.js';
import {
  AdminConfigMutationService,
  ConfigConflictError,
  ConfigMutationCommittedError,
  ProductionConfigPublishRequiredError,
  ProductionConfirmationError,
  RuntimeRestoreFailedError,
} from '../config/adminConfigMutationService.js';
import {
  AdminConfigOperationConflictError,
  AdminConfigOperationPendingError,
} from '../config/adminConfigOperationJournal.js';
import {
  adminConfigReadMetadata,
  mutationBusinessBody,
  mutationRequestContext,
  sendConfigMutationError,
} from '../config/adminConfigMutationHttp.js';
import {
  assertAdminConfigOperationScope,
  type AdminConfigOperationId,
} from '../config/adminConfigOperationRegistry.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import {
  GrokCredentialError,
  type GrokCredentialManager,
} from '../runtime/responses/grokCredentialManager.js';
import { GrokProtocolError, isRecord } from '../runtime/responses/grokProtocol.js';
import type { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import type { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';
import { orderedCredentialRefs } from '../runtime/responses/subscriptionAccountBinding.js';
export interface GrokSubscriptionAdminOptions {
  processCwd: string;
  config: AppConfig;
  credentialManager: GrokCredentialManager;
  deviceAuthService: GrokDeviceAuthService;
  modelCatalog?: GrokModelCatalogService;
  configMutationService?: AdminConfigMutationService;
  completionTaskLimit?: number;
  completionTaskTtlMs?: number;
}
export class GrokAdminInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'GROK_INVALID_REQUEST',
  ) {
    super(message);
  }
}
export function grokAdminOwner(req: Request): string {
  const owner = req.user?.sub ?? req.user?.username;
  if (!owner) throw new GrokAdminInputError('缺少平台管理员身份', 403);
  return owner;
}
export function grokAdminBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  if (req.body !== undefined && !isRecord(req.body))
    throw new GrokAdminInputError('请求正文必须是对象');
  const body = mutationBusinessBody(req);
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new GrokAdminInputError('请求包含不允许的字段');
  return body;
}
export function refsFromRaw(current: Record<string, unknown>): string[] {
  return orderedCredentialRefs({
    credentialRef: typeof current.credentialRef === 'string' ? current.credentialRef : undefined,
    credentialRefs: Array.isArray(current.credentialRefs)
      ? current.credentialRefs.filter((ref): ref is string => typeof ref === 'string')
      : undefined,
  });
}
export function withGrokRefs(
  current: Record<string, unknown>,
  refs: string[],
  enabled?: boolean,
): Record<string, unknown> {
  const next = { ...current };
  delete next.credentialRef;
  delete next.credentialRefs;
  if (refs.length) {
    next.credentialRef = refs[0];
    next.credentialRefs = refs;
  }
  if (enabled !== undefined) next.enabled = enabled;
  return next;
}
export function createGrokAdminContext(options: GrokSubscriptionAdminOptions) {
  const service =
    options.configMutationService ??
    new AdminConfigMutationService({
      configPath: getAppConfigPath(options.processCwd),
      processCwd: options.processCwd,
      environment: readRuntimeIdentity().environment,
      processRole: 'all',
    });
  const assertWritable = () => {
    if (!service.getWritePolicy().canSave) throw new ProductionConfigPublishRequiredError();
  };
  const publicState = async () => {
    const config = options.credentialManager.getConfiguration();
    const credentials = await options.credentialManager.getStatuses();
    return {
      ...adminConfigReadMetadata(options.processCwd, service),
      config: {
        enabled: config.enabled,
        quotaCooldownMinutes: config.quotaCooldownMinutes,
        endpoint: config.endpoint,
        oauthClientId: config.oauthClientId,
        credentialCount: credentials.length,
      },
      credentials,
      credential: credentials[0] ?? { configured: false, connected: false },
      runtime: options.credentialManager.getRuntimeStatus(),
      capabilities: { websocket: false, modelCatalog: true },
    };
  };
  const mutate = (
    req: Request,
    operation: Extract<AdminConfigOperationId, `grok.${string}`>,
    build: (
      current: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>,
    operationId?: string,
  ) => {
    assertWritable();
    const requestContext = mutationRequestContext(req);
    return service.mutate({
      ...requestContext,
      ...(operationId ? { operationId } : {}),
      operation: { id: operation },
      changedPaths: ['grokSubscription'],
      buildCandidate: async (text, raw) => {
        const current = isRecord(raw.grokSubscription) ? raw.grokSubscription : {};
        const next = await build(current);
        const nextRaw = { ...raw, grokSubscription: next };
        parseAppConfig(nextRaw);
        assertAdminConfigOperationScope({ id: operation }, raw, nextRaw);
        // Persist only the requested raw fields, never unrelated Zod defaults.
        return applyEdits(
          text,
          modify(text, ['grokSubscription'], next, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }),
        );
      },
      applyRuntime: (candidate) => {
        // A failed first registration may legitimately roll back to an absent optional root.
        if (candidate.grokSubscription)
          options.config.grokSubscription = candidate.grokSubscription;
        else delete options.config.grokSubscription;
        options.modelCatalog?.invalidate();
      },
    });
  };
  return { options, service, assertWritable, publicState, mutate };
}
export type GrokAdminContext = ReturnType<typeof createGrokAdminContext>;
export function sendGrokAdminError(res: Response, error: unknown, warning?: string): void {
  if (error instanceof GrokAdminInputError) {
    res
      .status(error.status)
      .json({ code: error.code, error: error.message, ...(warning ? { warning } : {}) });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      code: 'GROK_INVALID_CONFIG',
      error: 'Grok 配置无效，请检查启停、冷却分钟数和账号列表',
      ...(warning ? { warning } : {}),
    });
    return;
  }
  if (error instanceof GrokProtocolError || error instanceof GrokCredentialError) {
    const status =
      error instanceof GrokProtocolError &&
      [400, 403, 404, 409, 410, 429].includes(error.status ?? 0)
        ? error.status!
        : 502;
    res.status(status).json({
      code: error.code,
      error: `Grok 操作未完成：${error.code}`,
      ...(warning ? { warning } : {}),
    });
    return;
  }
  if (error instanceof ConfigMutationCommittedError || error instanceof RuntimeRestoreFailedError) {
    res.status(500).json({
      code: error.code,
      error:
        'Grok 配置可能已提交或仍需运行态恢复，请刷新状态并使用原操作重试；未清理可能生效的凭据。',
      ...(warning ? { warning } : {}),
    });
    return;
  }
  if (
    error instanceof ConfigConflictError ||
    error instanceof ProductionConfigPublishRequiredError ||
    error instanceof ProductionConfirmationError ||
    error instanceof AdminConfigOperationConflictError ||
    error instanceof AdminConfigOperationPendingError
  ) {
    sendConfigMutationError(res, error, warning ? { warning } : {});
    return;
  }
  res.status(500).json({
    code: 'GROK_ADMIN_OPERATION_FAILED',
    error: 'Grok 操作失败，请检查配置发布和凭据存储状态',
    ...(warning ? { warning } : {}),
  });
}

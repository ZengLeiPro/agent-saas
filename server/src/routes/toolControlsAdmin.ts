import { readFileSync } from 'node:fs';
import { Router, type Response } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { auditLog } from '../data/login-logs/index.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import { configRevision } from './configWriteLock.js';
import type {
  AppConfig,
  ToolControlsConfig,
  ToolDescriptionOverride,
  WebToolsConfig,
} from '../app/config.js';
import {
  applyToolDescriptionOverride,
  findToolDescriptionInvariantViolations,
  isToolEnabled,
} from '../agent/toolRuntime.js';
import type { ToolDescriptor } from '../agent/toolRuntime.js';
import {
  PLATFORM_TOOL_CATALOG,
  PLATFORM_TOOL_CATALOG_BY_ID,
  PLATFORM_TOOL_SOURCE_MODULE,
} from '../agent/toolCatalog.js';
import { GLOBAL_OWNER_ID, type SecretVault, type VaultCaller } from '../security/secretVault.js';
import {
  AdminConfigMutationService,
  ConfigConflictError,
  configFingerprint,
} from '../config/adminConfigMutationService.js';
import { mutationRequestContext, sendConfigMutationError } from '../config/adminConfigMutationHttp.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import type { Request } from 'express';
import { RouteSecretRefMutation } from './secretRefMutation.js';

const SEARCH_SECRET_WRITER: VaultCaller = {
  actor: 'system',
  userId: 'tool_controls_admin',
  scopes: ['secret:web_tools:write', 'secret:web_tools:revoke'],
};

function configRequestRevisions(req: Request): string[] {
  const ifMatch = mutationRequestContext(req).expectedFingerprint;
  return [typeof req.body?.expectedRevision === 'string' ? req.body.expectedRevision : undefined, ifMatch]
    .filter((revision): revision is string => Boolean(revision));
}

function revisionConflict(configText: string): ConfigConflictError {
  return new ConfigConflictError(configFingerprint(parseJsonc(configText)), configRevision(configText));
}

function sendRevisionMutationError(res: Response, error: unknown, safeMessage?: string): void {
  if (error instanceof ConfigConflictError && error.currentRevision) {
    res.setHeader('ETag', `"${error.currentRevision}"`);
    res.status(409).json({ error: error.message, code: error.code, revision: error.currentRevision });
    return;
  }
  if (safeMessage !== undefined) {
    res.status(500).json({ error: safeMessage });
    return;
  }
  sendConfigMutationError(res, error);
}

export interface CreateToolControlsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  secretVault?: SecretVault;
  validateToolSettingsConfig?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void> | void;
  onToolSettingsUpdated?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void> | void;
  configMutationService?: AdminConfigMutationService;
  /** 写候选前强制将精确磁盘快照完整应用到运行时。 */
  ensureConfigBaselineApplied?: (expectedText: string) => Promise<boolean>;
  /** durable commit 后用精确落盘文本推进共享 ConfigIdentity。 */
  onConfigReloaded?: (expectedConfigText: string) => Promise<void> | void;
  requireRevision?: boolean;
}

type RawObject = Record<string, unknown>;

function isObject(value: unknown): value is RawObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function currentWebTools(rawConfig: unknown): RawObject | undefined {
  if (!isObject(rawConfig)) return undefined;
  return isObject(rawConfig.webTools) ? rawConfig.webTools : undefined;
}

function stripSearchAdminFields(search: RawObject): RawObject {
  const next = { ...search };
  delete next.hasApiKey;
  delete next.apiKeyConfigured;
  if (next.apiKey === '') delete next.apiKey;
  if (next.apiKeyRef === '') delete next.apiKeyRef;
  if (isObject(next.global)) next.global = stripSearchAdminFields(next.global);
  return next;
}

function stripAdminOnlyFields(webTools: RawObject): RawObject {
  const next = { ...webTools };
  delete next.effectiveTools;
  if (isObject(next.search)) next.search = stripSearchAdminFields(next.search);
  return next;
}

function hydrateCredential(
  existing: RawObject | undefined,
  requested: RawObject,
  defaultProvider: string,
  label: string,
): void {
  const requestedInline = typeof requested.apiKey === 'string' && requested.apiKey.length > 0
    ? requested.apiKey
    : undefined;
  const requestedRef = typeof requested.apiKeyRef === 'string' && requested.apiKeyRef.length > 0
    ? requested.apiKeyRef
    : undefined;
  if (requestedInline || !existing) return;

  const existingInline = typeof existing.apiKey === 'string' && existing.apiKey.length > 0
    ? existing.apiKey
    : undefined;
  const existingRef = typeof existing.apiKeyRef === 'string' && existing.apiKeyRef.length > 0
    ? existing.apiKeyRef
    : undefined;
  const reusesExistingCredential = !requestedRef || requestedRef === existingRef;
  if (!reusesExistingCredential || (!existingInline && !existingRef)) return;

  const existingProvider = typeof existing.provider === 'string' ? existing.provider : defaultProvider;
  const requestedProvider = typeof requested.provider === 'string' ? requested.provider : defaultProvider;
  const existingEndpoint = typeof existing.endpoint === 'string' ? existing.endpoint : '';
  const requestedEndpoint = typeof requested.endpoint === 'string' ? requested.endpoint : '';
  if (existingProvider !== requestedProvider || existingEndpoint !== requestedEndpoint) {
    throw new Error(`${label} provider 或 endpoint 已变更，必须重新提供 API Key`);
  }
  if (!requestedRef) {
    if (existingInline) requested.apiKey = existingInline;
    else requested.apiKeyRef = existingRef;
  }
}

function hydratePreservedSearchCredential(rawConfig: unknown, webTools: unknown): unknown {
  if (webTools === null || webTools === undefined) return undefined;
  if (!isObject(webTools)) return webTools;

  const next = stripAdminOnlyFields(webTools);
  if (!isObject(next.search)) return next;

  const existing = currentWebTools(rawConfig);
  const existingSearch = isObject(existing?.search) ? existing.search : undefined;
  const search: RawObject = { ...next.search };
  hydrateCredential(existingSearch, search, 'volcengine', 'WebSearch 主源');

  const existingGlobal = isObject(existingSearch?.global) ? existingSearch.global : undefined;
  const globalSpecified = Object.prototype.hasOwnProperty.call(search, 'global');
  if (search.global === null) {
    delete search.global;
  } else if (!globalSpecified) {
    if (existingGlobal) search.global = { ...existingGlobal };
  } else if (isObject(search.global)) {
    const globalSearch: RawObject = { ...search.global };
    hydrateCredential(existingGlobal, globalSearch, 'tavily', 'WebSearch 境外源');
    search.global = globalSearch;
  }
  return { ...next, search };
}

function pruneUnknownToolControls(toolControls: ToolControlsConfig): ToolControlsConfig {
  if (!toolControls) return toolControls;
  const configuredTools = toolControls.tools ?? {};
  const knownTools = Object.fromEntries(
    Object.entries(configuredTools).filter(([toolId]) => PLATFORM_TOOL_CATALOG_BY_ID.has(toolId)),
  );
  // CreateArtifact 合并进 Artifact 后保留显式禁用态；不迁移旧 descriptionOverride，
  // 因为其中可能仍要求模型手写已退休的 fileCardMarker。
  if (configuredTools.CreateArtifact?.enabled === false) {
    knownTools.Artifact = { ...knownTools.Artifact, enabled: false };
  }
  const next = { ...toolControls };
  if (Object.keys(knownTools).length > 0) next.tools = knownTools;
  else delete next.tools;
  return next;
}

function sanitizeToolControlsConfig(toolControls: ToolControlsConfig): ToolControlsConfig | null {
  return pruneUnknownToolControls(toolControls) ?? null;
}

export function listConfiguredWebToolNames(webTools: WebToolsConfig, toolControls?: ToolControlsConfig): string[] {
  if (!webTools || webTools.enabled === false) return [];
  const tools: string[] = [];
  if (webTools.search && webTools.search.enabled !== false && isToolEnabled(toolControls, 'WebSearch')) tools.push('WebSearch');
  if (webTools.fetch?.enabled !== false && isToolEnabled(toolControls, 'WebFetch')) tools.push('WebFetch');
  return tools;
}

export function sanitizeWebToolsConfig(webTools: WebToolsConfig) {
  if (!webTools) return null;
  const { search, ...rest } = webTools;
  if (!search) return rest;
  const { apiKey, global: globalSearch, ...safeSearch } = search;
  const sanitizedGlobal = globalSearch
    ? (() => {
        const { apiKey: globalApiKey, ...safeGlobal } = globalSearch;
        return {
          ...safeGlobal,
          hasApiKey: (typeof globalApiKey === 'string' && globalApiKey.length > 0)
            || (typeof safeGlobal.apiKeyRef === 'string' && safeGlobal.apiKeyRef.length > 0),
        };
      })()
    : undefined;
  return {
    ...rest,
    search: {
      ...safeSearch,
      hasApiKey: (typeof apiKey === 'string' && apiKey.length > 0)
        || (typeof safeSearch.apiKeyRef === 'string' && safeSearch.apiKeyRef.length > 0),
      ...(sanitizedGlobal ? { global: sanitizedGlobal } : {}),
    },
  };
}

function webSearchSecretRefs(
  settings: Pick<AppConfig, 'toolControls' | 'webTools'> | undefined,
): Array<string | undefined> {
  return [settings?.webTools?.search?.apiKeyRef, settings?.webTools?.search?.global?.apiKeyRef];
}

function submittedWebSearchSecrets(body: unknown): Array<string | undefined> {
  if (!isObject(body) || !isObject(body.webTools) || !isObject(body.webTools.search)) return [];
  const search = body.webTools.search;
  return [
    typeof search.apiKey === 'string' ? search.apiKey : undefined,
    typeof search.apiKeyRef === 'string' ? search.apiKeyRef : undefined,
    isObject(search.global) && typeof search.global.apiKey === 'string'
      ? search.global.apiKey
      : undefined,
    isObject(search.global) && typeof search.global.apiKeyRef === 'string'
      ? search.global.apiKeyRef
      : undefined,
  ];
}

async function persistSearchCredential(
  settings: Pick<AppConfig, 'toolControls' | 'webTools'>,
  secretMutation: RouteSecretRefMutation,
): Promise<Pick<AppConfig, 'toolControls' | 'webTools'>> {
  const search = settings.webTools?.search;
  if (!search) return settings;
  if (!search.apiKey && !search.global?.apiKey) return settings;
  if (!secretMutation.available) {
    throw new Error('SecretVault 未配置，不能保存 WebSearch 密钥');
  }

  const vaultPut = (plaintext: string, provider: string | undefined, purpose: string) => secretMutation.put(
    GLOBAL_OWNER_ID,
    'web_tools',
    plaintext,
    { provider, purpose },
  );

  const { apiKey, global: globalSearch, ...safeSearch } = search;
  const ref = apiKey ? await vaultPut(apiKey, search.provider, 'web-search') : undefined;

  // 境外源凭据与主源同等进入 Vault：绝不把明文留在 config.json（2026-08-16 实测漏配）。
  let safeGlobal = globalSearch;
  if (globalSearch?.apiKey) {
    const { apiKey: globalKey, ...restGlobal } = globalSearch;
    const globalRef = await vaultPut(globalKey, globalSearch.provider, 'web-search-global');
    safeGlobal = { ...restGlobal, apiKeyRef: globalRef };
  }

  return {
    ...settings,
    webTools: {
      ...settings.webTools,
      search: {
        ...safeSearch,
        ...(ref ? { apiKeyRef: ref } : {}),
        ...(safeGlobal ? { global: safeGlobal } : {}),
      },
    },
  };
}

/**
 * 从 descriptor 序列化 JSON Schema。优先使用 parametersJsonSchema（MCP 透传），
 * fallback 到 zod 自动转换。clone 后删除 $schema 字段以匹配 toModelToolDefinition
 * 里发给 LLM 的形态——admin UI 展示的应该和模型实际看到的一致。
 */
function descriptorInputSchema(descriptor: ToolDescriptor): Record<string, unknown> {
  const schema = descriptor.parametersJsonSchema
    ? { ...descriptor.parametersJsonSchema }
    : (descriptor.schema.toJSONSchema() as Record<string, unknown>);
  delete schema.$schema;
  return schema;
}

function toolCatalogWithState(toolControls: ToolControlsConfig) {
  return PLATFORM_TOOL_CATALOG.map((tool) => {
    const controlEntry = toolControls?.tools?.[tool.id] ?? toolControls?.tools?.[tool.name];
    const effective = applyToolDescriptionOverride(tool, toolControls);
    return {
      id: tool.id,
      name: tool.name,
      displayName: tool.displayName,
      category: tool.category ?? 'core',
      label: tool.label ?? tool.displayName,
      enabled: isToolEnabled(toolControls, tool),
      description: tool.description,
      effectiveDescription: effective.description,
      inputSchema: descriptorInputSchema(tool),
      risk: tool.risk,
      approvalMode: tool.approvalMode,
      auditCategory: tool.auditCategory,
      ...(controlEntry?.descriptionOverride ? { descriptionOverride: controlEntry.descriptionOverride } : {}),
      ...(PLATFORM_TOOL_SOURCE_MODULE[tool.id] ? { sourceModule: PLATFORM_TOOL_SOURCE_MODULE[tool.id] } : {}),
    };
  });
}

function validateToolSettingsUpdate(
  currentRaw: unknown,
  toolControls: unknown,
  webTools: unknown,
): Pick<AppConfig, 'toolControls' | 'webTools'> {
  const hydratedWebTools = hydratePreservedSearchCredential(currentRaw, webTools);
  const merged = {
    ...(isObject(currentRaw) ? currentRaw : {}),
    toolControls: toolControls ?? undefined,
    webTools: hydratedWebTools,
  };
  const parsed = parseAppConfig(merged);
  const prunedToolControls = pruneUnknownToolControls(parsed.toolControls);
  assertDescriptionInvariants(prunedToolControls);
  return {
    toolControls: prunedToolControls,
    webTools: parsed.webTools,
  };
}

/**
 * 描述覆盖不得抹掉与运行时行为绑定的关键片段。
 *
 * CI 里的 drift guard 守的是内置默认描述，守不住这里的后台覆盖：`mode: 'replace'`
 * 能把 Read 的字节上限、Shell 的 rg 优先级整段换掉，模型随即按错误契约行动，而
 * 没有任何测试会红。这道闸门把同一份 descriptionInvariants 声明用在保存时。
 */
function assertDescriptionInvariants(toolControls: ToolControlsConfig | undefined): void {
  const violations = findToolDescriptionInvariantViolations(PLATFORM_TOOL_CATALOG, toolControls);
  if (!violations.length) return;
  const detail = violations
    .map(({ toolId, missing }) => `${toolId} 缺少 ${missing.map((item) => `「${item}」`).join('、')}`)
    .join('；');
  throw new Error(`描述覆盖丢失了必须保留的运行时契约片段：${detail}`);
}

/**
 * 合并单工具 patch 到当前 toolControls。生成给 parseAppConfig 校验用的下一版
 * toolControls 对象；null 语义在这层展开：
 *   - patch.enabled === undefined → 保留原 enabled
 *   - patch.descriptionOverride === undefined → 保留原 override
 *   - patch.descriptionOverride === null → 移除 override
 *   - patch.descriptionOverride === {mode,text} → 覆盖
 * 当合并后条目所有字段都是"默认"（enabled≠false 且无 override），直接把该 key
 * 从 tools 里删掉，避免 config.json 里留空条目。
 */
function mergeSingleToolPatch(
  current: ToolControlsConfig | undefined,
  toolId: string,
  patch: { enabled?: unknown; descriptionOverride?: unknown },
): ToolControlsConfig {
  const currentTools = current?.tools ?? {};
  const existing = currentTools[toolId] ?? {};

  const nextEntry: { enabled?: boolean; descriptionOverride?: ToolDescriptionOverride } = { ...existing };

  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    if (typeof patch.enabled !== 'boolean') {
      throw new Error('enabled 必须是布尔');
    }
    if (patch.enabled) delete nextEntry.enabled;
    else nextEntry.enabled = false;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'descriptionOverride')) {
    if (patch.descriptionOverride === null) {
      delete nextEntry.descriptionOverride;
    } else if (isObject(patch.descriptionOverride)) {
      // 交给 parseAppConfig 里的 zod schema 做严格校验，这里只放通。
      nextEntry.descriptionOverride = patch.descriptionOverride as ToolDescriptionOverride;
    } else {
      throw new Error('descriptionOverride 必须是 {mode, text} 或 null');
    }
  }

  const nextTools: Record<string, { enabled?: boolean; descriptionOverride?: ToolDescriptionOverride }> = { ...currentTools };
  if (Object.keys(nextEntry).length === 0) {
    delete nextTools[toolId];
  } else {
    nextTools[toolId] = nextEntry;
  }

  const merged: ToolControlsConfig = { ...(current ?? {}) };
  if (Object.keys(nextTools).length === 0) {
    delete (merged as { tools?: unknown }).tools;
  } else {
    merged.tools = nextTools;
  }
  // 保留 enabled 全局字段（可能是 undefined 或 false，parseAppConfig 会归一）
  if (Object.keys(merged).length === 0) return {};
  return merged;
}

/**
 * 单工具 PUT 端点的落盘 helper：基线已确认后写 config.json → 热更 → 返回完整 catalog 视图。
 * 与整包 PUT 共用最终的 writeFileSync/热更逻辑，避免写不同分支导致行为漂移。
 */
async function persistUpdatedSettings(
  options: CreateToolControlsAdminRouterOptions,
  configMutationService: AdminConfigMutationService,
  req: Request,
  expectedConfigText: string,
  nextSettings: Pick<AppConfig, 'toolControls' | 'webTools'>,
  onCommitted?: (candidateText: string) => Promise<void>,
): Promise<{ settings: Pick<AppConfig, 'toolControls' | 'webTools'>; revision: string }> {
  const requestContext = mutationRequestContext(req);
  const expectedRevisions = configRequestRevisions(req);
  const result = await configMutationService.mutate({
    actor: requestContext.actor,
    expectedRevision: expectedRevisions[0],
    changedPaths: ['toolControls', 'webTools'],
    validateBaseline: (currentText) => {
      const revision = configRevision(currentText);
      if (currentText !== expectedConfigText || expectedRevisions.some((expected) => expected !== revision)) {
        throw revisionConflict(currentText);
      }
    },
    buildCandidate: (configText) => {
      const withWebTools = applyEdits(configText, modify(configText, ['webTools'], nextSettings.webTools, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
      return applyEdits(withWebTools, modify(withWebTools, ['toolControls'], nextSettings.toolControls, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
    },
    applyRuntime: async (candidate) => {
      options.config.toolControls = candidate.toolControls;
      options.config.webTools = candidate.webTools;
      await options.onToolSettingsUpdated?.({
        toolControls: candidate.toolControls,
        webTools: candidate.webTools,
      });
    },
    onCommitted: async (candidateText) => {
      try {
        await options.onConfigReloaded?.(candidateText);
      } finally {
        await onCommitted?.(candidateText);
      }
    },
  });
  return {
    settings: { toolControls: result.config.toolControls, webTools: result.config.webTools },
    revision: result.revision,
  };
}

function catalogResponse(settings: Pick<AppConfig, 'toolControls' | 'webTools'>, revision: string) {
  return {
    revision,
    toolControls: sanitizeToolControlsConfig(settings.toolControls),
    tools: toolCatalogWithState(settings.toolControls),
    webTools: sanitizeWebToolsConfig(settings.webTools),
    effectiveWebTools: listConfiguredWebToolNames(settings.webTools, settings.toolControls),
  };
}

export function createToolControlsAdminRouter(options: CreateToolControlsAdminRouterOptions): Router {
  const router = Router();
  const configMutationService = options.configMutationService ?? new AdminConfigMutationService({
    configPath: getAppConfigPath(options.processCwd),
    processCwd: options.processCwd,
    environment: readRuntimeIdentity().environment,
    processRole: 'all',
  });

  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    const configText = readFileSync(getAppConfigPath(options.processCwd), 'utf-8');
    const diskConfig = parseAppConfig(parseJsonc(configText));
    const revision = configRevision(configText);
    res.setHeader('ETag', `"${revision}"`);
    res.json(catalogResponse({ toolControls: diskConfig.toolControls, webTools: diskConfig.webTools }, revision));
  });

  router.put('/', async (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let configText: string; let nextSettings: Pick<AppConfig, 'toolControls' | 'webTools'>;
    const secretMutation = new RouteSecretRefMutation(options.secretVault, SEARCH_SECRET_WRITER);

    try {
      configText = readFileSync(configPath, 'utf-8');
      const revision = configRevision(configText); const expectedRevisions = configRequestRevisions(req);
      if ((options.requireRevision && expectedRevisions.length === 0) || expectedRevisions.some((expected) => expected !== revision)) throw revisionConflict(configText);
      if (options.ensureConfigBaselineApplied && !await options.ensureConfigBaselineApplied(configText)) throw new Error('当前配置基线未完整应用，拒绝写入');
      const latestText = readFileSync(configPath, 'utf-8');
      if (latestText !== configText) throw revisionConflict(latestText);
      const rawConfig = parseJsonc(configText);
      secretMutation.trackPrevious(webSearchSecretRefs(parseAppConfig(rawConfig)));
      nextSettings = validateToolSettingsUpdate(rawConfig, req.body?.toolControls, req.body?.webTools);
      nextSettings = await persistSearchCredential(nextSettings, secretMutation);
      // 与运行时相同，验证 hook 只接收已去明文且可实际解析的 SecretVault ref 配置。
      await options.validateToolSettingsConfig?.(nextSettings);
    } catch (error) {
      const message = secretMutation.redactError(error, submittedWebSearchSecrets(req.body));
      await secretMutation.failed(error, webSearchSecretRefs(nextSettings!));
      if (error instanceof ConfigConflictError) { sendRevisionMutationError(res, error); return; }
      res.status(400).json({ error: message });
      return;
    }

    try {
      const persisted = await persistUpdatedSettings(
        options,
        configMutationService,
        req,
        configText,
        nextSettings,
        async (candidateText) => {
          const committedConfig = parseAppConfig(parseJsonc(candidateText));
          await secretMutation.committed(webSearchSecretRefs(committedConfig));
        },
      );
      auditLog(req, 'tool_controls_updated', describeToolControlsChange(persisted.settings.toolControls));
      res.setHeader('ETag', `"${persisted.revision}"`);
      res.json(catalogResponse(persisted.settings, persisted.revision));
    } catch (error) {
      const message = secretMutation.redactError(error, [
        ...submittedWebSearchSecrets(req.body),
        ...webSearchSecretRefs(nextSettings),
      ]);
      await secretMutation.failed(error, webSearchSecretRefs(nextSettings));
      sendRevisionMutationError(res, error, message);
    }
  });

  /**
   * 单工具粒度 PUT：只改指定工具的 enabled / descriptionOverride，其他工具与
   * webTools 保持不变。用于详情页保存，避免整包提交导致 admin 之间互相覆盖。
   */
  router.put('/:toolId', async (req, res) => {
    const { toolId } = req.params;
    if (!PLATFORM_TOOL_CATALOG_BY_ID.has(toolId)) {
      res.status(404).json({ error: `未知工具 ${toolId}` });
      return;
    }

    const configPath = getAppConfigPath(options.processCwd);
    let configText: string; let nextSettings: Pick<AppConfig, 'toolControls' | 'webTools'>;

    try {
      configText = readFileSync(configPath, 'utf-8');
      const revision = configRevision(configText); const expectedRevisions = configRequestRevisions(req);
      if ((options.requireRevision && expectedRevisions.length === 0) || expectedRevisions.some((expected) => expected !== revision)) throw revisionConflict(configText);
      if (options.ensureConfigBaselineApplied && !await options.ensureConfigBaselineApplied(configText)) throw new Error('当前配置基线未完整应用，拒绝写入');
      const latestText = readFileSync(configPath, 'utf-8');
      if (latestText !== configText) throw revisionConflict(latestText);
      const rawConfig = parseJsonc(configText);
      // 管理端可能运行在蓝绿切换后的旧进程中：内存 config 未必包含其他进程
      // 已落盘的 override。单工具 patch 必须以刚读到的磁盘快照为基线，否则
      // 随后的保存会把不在旧内存里的工具恢复默认，重启后才暴露该丢失。
      const persistedConfig = parseAppConfig(rawConfig);
      const mergedToolControls = mergeSingleToolPatch(
        persistedConfig.toolControls,
        toolId,
        req.body ?? {},
      );
      nextSettings = validateToolSettingsUpdate(
        rawConfig,
        mergedToolControls,
        persistedConfig.webTools ?? undefined,
      );
      await options.validateToolSettingsConfig?.(nextSettings);
    } catch (error) {
      if (error instanceof ConfigConflictError) { sendRevisionMutationError(res, error); return; }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      const persisted = await persistUpdatedSettings(
        options,
        configMutationService,
        req,
        configText,
        nextSettings,
      );
      auditLog(req, 'tool_controls_updated', `${toolId}：${describeToolEntry(persisted.settings.toolControls, toolId)}`);
      res.setHeader('ETag', `"${persisted.revision}"`);
      res.json(catalogResponse(persisted.settings, persisted.revision));
    } catch (error) {
      sendRevisionMutationError(res, error);
    }
  });

  return router;
}

/** 单个工具的最终状态摘要，进审计 detail。不记描述正文，只记是否被覆盖及模式。 */
function describeToolEntry(toolControls: ToolControlsConfig | undefined, toolId: string): string {
  const entry = toolControls?.tools?.[toolId];
  if (!entry) return '恢复默认';
  const parts = [entry.enabled === false ? '已禁用' : '已启用'];
  parts.push(entry.descriptionOverride
    ? `描述覆盖(${entry.descriptionOverride.mode ?? 'append'})`
    : '描述默认');
  return parts.join('，');
}

/** 整包保存的审计 detail：列出所有非默认工具，避免 detail 里塞进全部描述正文。 */
function describeToolControlsChange(toolControls: ToolControlsConfig | undefined): string {
  const entries = Object.keys(toolControls?.tools ?? {});
  if (!entries.length) return '全部工具恢复默认';
  return entries.map((toolId) => `${toolId}：${describeToolEntry(toolControls, toolId)}`).join('；');
}

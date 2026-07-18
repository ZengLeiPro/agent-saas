import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type {
  AppConfig,
  ToolControlsConfig,
  ToolDescriptionOverride,
  WebToolsConfig,
} from '../app/config.js';
import { applyToolDescriptionOverride, isToolEnabled } from '../agent/toolRuntime.js';
import type { ToolDescriptor } from '../agent/toolRuntime.js';
import {
  PLATFORM_TOOL_CATALOG,
  PLATFORM_TOOL_CATALOG_BY_ID,
  PLATFORM_TOOL_SOURCE_MODULE,
} from '../agent/toolCatalog.js';
import { GLOBAL_OWNER_ID, type SecretVault } from '../security/secretVault.js';

export interface CreateToolControlsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  secretVault?: SecretVault;
  validateToolSettingsConfig?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void> | void;
  onToolSettingsUpdated?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void> | void;
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
  return next;
}

function stripAdminOnlyFields(webTools: RawObject): RawObject {
  const next = { ...webTools };
  delete next.effectiveTools;
  if (isObject(next.search)) next.search = stripSearchAdminFields(next.search);
  return next;
}

function hydratePreservedSearchCredential(rawConfig: unknown, webTools: unknown): unknown {
  if (webTools === null || webTools === undefined) return undefined;
  if (!isObject(webTools)) return webTools;

  const next = stripAdminOnlyFields(webTools);
  if (!isObject(next.search)) return next;

  const search = next.search;
  const hasInline = typeof search.apiKey === 'string' && search.apiKey.length > 0;
  const hasRef = typeof search.apiKeyRef === 'string' && search.apiKeyRef.length > 0;
  if (hasInline || hasRef) return next;

  const existing = currentWebTools(rawConfig);
  const existingSearch = isObject(existing?.search) ? existing.search : undefined;
  if (typeof existingSearch?.apiKey === 'string' && existingSearch.apiKey.length > 0) {
    return { ...next, search: { ...search, apiKey: existingSearch.apiKey } };
  }
  if (typeof existingSearch?.apiKeyRef === 'string' && existingSearch.apiKeyRef.length > 0) {
    return { ...next, search: { ...search, apiKeyRef: existingSearch.apiKeyRef } };
  }
  return next;
}

function sanitizeToolControlsConfig(toolControls: ToolControlsConfig): ToolControlsConfig | null {
  return toolControls ?? null;
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
  const { apiKey, ...safeSearch } = search;
  return {
    ...rest,
    search: {
      ...safeSearch,
      hasApiKey: (typeof apiKey === 'string' && apiKey.length > 0)
        || (typeof safeSearch.apiKeyRef === 'string' && safeSearch.apiKeyRef.length > 0),
    },
  };
}

async function persistSearchCredential(
  settings: Pick<AppConfig, 'toolControls' | 'webTools'>,
  secretVault?: SecretVault,
): Promise<Pick<AppConfig, 'toolControls' | 'webTools'>> {
  const search = settings.webTools?.search;
  if (!secretVault || !search?.apiKey) return settings;

  const { apiKey, ...safeSearch } = search;
  const ref = await secretVault.putSecret(GLOBAL_OWNER_ID, 'web_tools', apiKey, {
    provider: search.provider,
    purpose: 'web-search',
  });
  return {
    ...settings,
    webTools: {
      ...settings.webTools,
      search: {
        ...safeSearch,
        apiKeyRef: ref.id,
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
  return {
    toolControls: parsed.toolControls,
    webTools: parsed.webTools,
  };
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
 * 单工具 PUT 端点的落盘 helper：验证 → 写 config.json → 热更 → 返回完整 catalog 视图。
 * 与整包 PUT 共用最终的 writeFileSync/热更逻辑，避免写不同分支导致行为漂移。
 */
async function persistUpdatedSettings(
  options: CreateToolControlsAdminRouterOptions,
  nextSettings: Pick<AppConfig, 'toolControls' | 'webTools'>,
): Promise<Pick<AppConfig, 'toolControls' | 'webTools'>> {
  const configPath = getAppConfigPath(options.processCwd);
  const configText = readFileSync(configPath, 'utf-8');

  const webToolsEdits = modify(configText, ['webTools'], nextSettings.webTools, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const withWebTools = applyEdits(configText, webToolsEdits);
  const toolControlsEdits = modify(withWebTools, ['toolControls'], nextSettings.toolControls, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const updatedText = applyEdits(withWebTools, toolControlsEdits);
  writeFileSync(configPath, updatedText, 'utf-8');
  options.config.toolControls = nextSettings.toolControls;
  options.config.webTools = nextSettings.webTools;
  await options.onToolSettingsUpdated?.(nextSettings);
  return nextSettings;
}

function catalogResponse(settings: Pick<AppConfig, 'toolControls' | 'webTools'>) {
  return {
    toolControls: sanitizeToolControlsConfig(settings.toolControls),
    tools: toolCatalogWithState(settings.toolControls),
    webTools: sanitizeWebToolsConfig(settings.webTools),
    effectiveWebTools: listConfiguredWebToolNames(settings.webTools, settings.toolControls),
  };
}

export function createToolControlsAdminRouter(options: CreateToolControlsAdminRouterOptions): Router {
  const router = Router();

  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json(catalogResponse({
      toolControls: options.config.toolControls,
      webTools: options.config.webTools,
    }));
  });

  router.put('/', async (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let nextSettings: Pick<AppConfig, 'toolControls' | 'webTools'>;

    try {
      const configText = readFileSync(configPath, 'utf-8');
      const rawConfig = parseJsonc(configText);
      nextSettings = validateToolSettingsUpdate(rawConfig, req.body?.toolControls, req.body?.webTools);
      await options.validateToolSettingsConfig?.(nextSettings);
      nextSettings = await persistSearchCredential(nextSettings, options.secretVault);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      const persisted = await persistUpdatedSettings(options, nextSettings);
      res.json(catalogResponse(persisted));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
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
    let nextSettings: Pick<AppConfig, 'toolControls' | 'webTools'>;

    try {
      const configText = readFileSync(configPath, 'utf-8');
      const rawConfig = parseJsonc(configText);
      const mergedToolControls = mergeSingleToolPatch(
        options.config.toolControls,
        toolId,
        req.body ?? {},
      );
      nextSettings = validateToolSettingsUpdate(
        rawConfig,
        mergedToolControls,
        options.config.webTools ?? undefined,
      );
      await options.validateToolSettingsConfig?.(nextSettings);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      const persisted = await persistUpdatedSettings(options, nextSettings);
      res.json(catalogResponse(persisted));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

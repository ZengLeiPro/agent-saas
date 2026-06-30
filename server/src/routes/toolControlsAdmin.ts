import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, ToolControlsConfig, WebToolsConfig } from '../app/config.js';
import { isToolEnabled } from '../agent/toolRuntime.js';

export interface CreateToolControlsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  validateToolSettingsConfig?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void> | void;
  onToolSettingsUpdated?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void> | void;
}

type RawObject = Record<string, unknown>;

export const BUILTIN_TOOL_CATALOG = [
  { id: 'WaitForWorkspaceReady', name: 'WaitForWorkspaceReady', category: 'workspace', label: '等待工作区就绪' },
  { id: 'Read', name: 'Read', category: 'workspace', label: '读取文件' },
  { id: 'Write', name: 'Write', category: 'workspace', label: '写入文件' },
  { id: 'List', name: 'List', category: 'workspace', label: '列出文件' },
  { id: 'Edit', name: 'Edit', category: 'workspace', label: '精确编辑文件' },
  { id: 'Glob', name: 'Glob', category: 'workspace', label: 'Glob 查找文件' },
  { id: 'Grep', name: 'Grep', category: 'workspace', label: '正则搜索文件' },
  { id: 'CreateArtifact', name: 'CreateArtifact', category: 'workspace', label: '创建 Artifact' },
  { id: 'Shell', name: 'Shell', category: 'workspace', label: '执行 Shell' },
  { id: 'MemorySearch', name: 'MemorySearch', category: 'memory', label: '搜索记忆' },
  { id: 'MemoryList', name: 'MemoryList', category: 'memory', label: '列出记忆文件' },
  { id: 'ReadCompanyInfo', name: 'ReadCompanyInfo', category: 'memory', label: '读取组织资料' },
  { id: 'UpdateCompanyInfo', name: 'UpdateCompanyInfo', category: 'memory', label: '更新组织资料' },
  { id: 'Skill', name: 'Skill', category: 'skill', label: '调用 Skill' },
  { id: 'TodoWrite', name: 'TodoWrite', category: 'meta', label: '管理 TODO' },
  { id: 'AskUserQuestion', name: 'AskUserQuestion', category: 'meta', label: '向用户提问' },
  { id: 'SessionGetEvents', name: 'SessionGetEvents', category: 'session', label: '读取会话事件' },
  { id: 'SessionSearchEvents', name: 'SessionSearchEvents', category: 'session', label: '搜索会话事件' },
  { id: 'SessionGetToolTrace', name: 'SessionGetToolTrace', category: 'session', label: '查看工具调用追踪' },
  { id: 'WebSearch', name: 'WebSearch', category: 'web', label: '网络搜索' },
  { id: 'WebFetch', name: 'WebFetch', category: 'web', label: '网页访问' },
] as const;

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
      hasApiKey: typeof apiKey === 'string' && apiKey.length > 0,
    },
  };
}

function toolCatalogWithState(toolControls: ToolControlsConfig) {
  return BUILTIN_TOOL_CATALOG.map((tool) => ({
    ...tool,
    enabled: isToolEnabled(toolControls, tool),
  }));
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

export function createToolControlsAdminRouter(options: CreateToolControlsAdminRouterOptions): Router {
  const router = Router();

  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json({
      toolControls: sanitizeToolControlsConfig(options.config.toolControls),
      tools: toolCatalogWithState(options.config.toolControls),
      webTools: sanitizeWebToolsConfig(options.config.webTools),
      effectiveWebTools: listConfiguredWebToolNames(options.config.webTools, options.config.toolControls),
    });
  });

  router.put('/', async (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let configText: string;
    let nextSettings: Pick<AppConfig, 'toolControls' | 'webTools'>;

    try {
      configText = readFileSync(configPath, 'utf-8');
      const rawConfig = parseJsonc(configText);
      nextSettings = validateToolSettingsUpdate(rawConfig, req.body?.toolControls, req.body?.webTools);
      await options.validateToolSettingsConfig?.(nextSettings);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
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
      res.json({
        toolControls: sanitizeToolControlsConfig(nextSettings.toolControls),
        tools: toolCatalogWithState(nextSettings.toolControls),
        webTools: sanitizeWebToolsConfig(nextSettings.webTools),
        effectiveWebTools: listConfiguredWebToolNames(nextSettings.webTools, nextSettings.toolControls),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

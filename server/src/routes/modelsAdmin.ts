import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { TITLE_SYSTEM_PROMPT } from '../agent/titleGenerator.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import { getPublicModelList } from '../app/models.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type {
  AppConfig,
  MemoryIndexAppConfig,
  ModelsConfig,
  SystemPromptsConfig,
  TitleGeneratorAppConfig,
} from '../app/config.js';

export interface CreateModelsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  onModelsUpdated?: (models: ModelsConfig) => void;
  onMemoryIndexUpdated?: (memoryIndex: MemoryIndexAppConfig | undefined) => void | Promise<void>;
  onSystemPromptOverridesUpdated?: (next: SystemPromptsConfig) => void;
}

type ModelsAdminUpdate = {
  models: ModelsConfig;
  memoryIndex: MemoryIndexAppConfig | null;
  memoryIndexProvided: boolean;
  titleGenerator: TitleGeneratorAppConfig | undefined;
  titleGeneratorProvided: boolean;
  systemPrompts: SystemPromptsConfig;
  titleSystemPromptProvided: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 凭据脱敏：
 * GET 不再返回分组 apiKey / memory embedding apiKey 明文（此前明文随响应回显到
 * 前端 password input，属于泄露面），改为 hasApiKey 布尔。PUT 侧配套「留空/缺失
 * = 保留现有」语义（restoreSecrets），与 toolControlsAdmin 的 vault 模式对齐。
 */
function redactModels(models: ModelsConfig): unknown {
  return {
    ...models,
    groups: models.groups.map((group) => {
      const { apiKey, ...rest } = group;
      return { ...rest, hasApiKey: typeof apiKey === 'string' && apiKey.length > 0 };
    }),
  };
}

function redactMemoryIndex(memoryIndex: MemoryIndexAppConfig | null): unknown {
  if (!memoryIndex) return null;
  const { apiKey, ...restEmbedding } = memoryIndex.embedding;
  return {
    ...memoryIndex,
    embedding: {
      ...restEmbedding,
      hasApiKey: typeof apiKey === 'string' && apiKey.length > 0,
    },
  };
}

function titleGeneratorView(config: AppConfig): TitleGeneratorAppConfig | undefined {
  if (config.titleGenerator) return config.titleGenerator;
  return config.models ? { model: config.models.default, fallbackModels: [] } : undefined;
}

function titleSystemPromptView(config: AppConfig) {
  const override = config.systemPrompts?.['utility.title'];
  return {
    content: override ?? TITLE_SYSTEM_PROMPT,
    defaultContent: TITLE_SYSTEM_PROMPT,
    overridden: typeof override === 'string',
  };
}

function validateTitleGeneratorModels(models: ModelsConfig, titleGenerator: TitleGeneratorAppConfig | undefined): void {
  if (!titleGenerator) return;
  const refs = [titleGenerator.model, ...(titleGenerator.fallbackModels ?? [])];
  if (new Set(refs).size !== refs.length) throw new Error('标题生成模型链不能包含重复模型');

  const available = new Set(models.groups.flatMap((group) => (
    group.models.map((model) => `${group.id}/${model.id}`)
  )));
  for (const ref of refs) {
    if (!available.has(ref)) throw new Error(`标题生成模型引用不存在：${ref}`);
  }
}

/** PUT 请求体中缺失/留空的 apiKey 按 group.id（memoryIndex 单例）从现有配置补回。 */
function restoreSecrets(body: unknown, config: AppConfig): unknown {
  if (!isRecord(body)) return body;
  const next: Record<string, unknown> = { ...body };

  if (Array.isArray(next.models ? (next.models as Record<string, unknown>).groups : undefined)) {
    const modelsRecord = next.models as Record<string, unknown>;
    const currentByGroupId = new Map(
      (config.models?.groups ?? []).map((g) => [g.id, g.apiKey]),
    );
    next.models = {
      ...modelsRecord,
      groups: (modelsRecord.groups as unknown[]).map((groupRaw) => {
        if (!isRecord(groupRaw)) return groupRaw;
        const { hasApiKey: _ignored, ...group } = groupRaw;
        const inlineKey = typeof group.apiKey === 'string' ? group.apiKey : undefined;
        if (inlineKey && inlineKey.length > 0) return group;
        const currentKey = typeof group.id === 'string' ? currentByGroupId.get(group.id) : undefined;
        if (currentKey) return { ...group, apiKey: currentKey };
        const { apiKey: _empty, ...withoutKey } = group;
        return withoutKey;
      }),
    };
  }

  if (isRecord(next.memoryIndex) && isRecord(next.memoryIndex.embedding)) {
    const embeddingRaw = next.memoryIndex.embedding as Record<string, unknown>;
    const { hasApiKey: _ignored, ...embedding } = embeddingRaw;
    const inlineKey = typeof embedding.apiKey === 'string' ? embedding.apiKey : undefined;
    if (!inlineKey || inlineKey.length === 0) {
      const currentKey = config.memory?.index?.embedding.apiKey;
      if (currentKey) {
        next.memoryIndex = { ...next.memoryIndex, embedding: { ...embedding, apiKey: currentKey } };
      } else {
        next.memoryIndex = { ...next.memoryIndex, embedding };
      }
    } else {
      next.memoryIndex = { ...next.memoryIndex, embedding };
    }
  }

  return next;
}

function validateModelsUpdate(currentRaw: unknown, body: unknown): ModelsAdminUpdate {
  const rawRecord = isRecord(currentRaw) ? currentRaw : {};
  const bodyRecord = isRecord(body) ? body : {};
  const memoryIndexProvided = Object.prototype.hasOwnProperty.call(bodyRecord, 'memoryIndex');
  const titleGeneratorProvided = Object.prototype.hasOwnProperty.call(bodyRecord, 'titleGenerator');
  const titleSystemPromptProvided = Object.prototype.hasOwnProperty.call(bodyRecord, 'titleSystemPrompt');
  const merged: Record<string, unknown> = {
    ...rawRecord,
    models: bodyRecord.models,
  };

  if (memoryIndexProvided) {
    const currentMemory = isRecord(rawRecord.memory) ? rawRecord.memory : {};
    if (bodyRecord.memoryIndex == null) {
      const nextMemory = { ...currentMemory };
      delete nextMemory.index;
      if (Object.keys(nextMemory).length > 0) {
        merged.memory = nextMemory;
      } else {
        delete merged.memory;
      }
    } else {
      merged.memory = {
        ...currentMemory,
        index: bodyRecord.memoryIndex,
      };
    }
  }

  if (titleGeneratorProvided) merged.titleGenerator = bodyRecord.titleGenerator;

  if (titleSystemPromptProvided) {
    if (typeof bodyRecord.titleSystemPrompt !== 'string' || !bodyRecord.titleSystemPrompt.trim()) {
      throw new Error('标题生成提示语不能为空');
    }
    const nextPrompts = isRecord(rawRecord.systemPrompts) ? { ...rawRecord.systemPrompts } : {};
    const content = bodyRecord.titleSystemPrompt.trim();
    if (content === TITLE_SYSTEM_PROMPT) delete nextPrompts['utility.title'];
    else nextPrompts['utility.title'] = content;
    if (Object.keys(nextPrompts).length > 0) merged.systemPrompts = nextPrompts;
    else delete merged.systemPrompts;
  }

  const parsed = parseAppConfig(merged);
  if (!parsed.models) throw new Error('models 未配置');
  validateTitleGeneratorModels(parsed.models, parsed.titleGenerator);
  return {
    models: parsed.models,
    memoryIndex: parsed.memory?.index ?? null,
    memoryIndexProvided,
    titleGenerator: parsed.titleGenerator,
    titleGeneratorProvided,
    systemPrompts: parsed.systemPrompts ?? {},
    titleSystemPromptProvided,
  };
}

export function createModelsAdminRouter(options: CreateModelsAdminRouterOptions): Router {
  const router = Router();

  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    if (!options.config.models) {
      res.status(404).json({ error: 'models 未配置' });
      return;
    }
    res.json({
      models: redactModels(options.config.models),
      memoryIndex: redactMemoryIndex(options.config.memory?.index ?? null),
      titleGenerator: titleGeneratorView(options.config),
      titleSystemPrompt: titleSystemPromptView(options.config),
      publicModelList: getPublicModelList(options.config.models),
    });
  });

  router.put('/', async (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let configText: string;
    let rawConfig: unknown;
    let nextUpdate: ModelsAdminUpdate;

    try {
      configText = readFileSync(configPath, 'utf-8');
      rawConfig = parseJsonc(configText);
      nextUpdate = validateModelsUpdate(rawConfig, restoreSecrets(req.body, options.config));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      let updatedText = configText;
      const edits = modify(updatedText, ['models'], nextUpdate.models, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      updatedText = applyEdits(updatedText, edits);
      if (nextUpdate.memoryIndexProvided) {
        const rawRecord = isRecord(rawConfig) ? rawConfig : {};
        const hasMemoryObject = isRecord(rawRecord.memory);
        const memoryEdits = nextUpdate.memoryIndex
          ? modify(
              updatedText,
              hasMemoryObject ? ['memory', 'index'] : ['memory'],
              hasMemoryObject ? nextUpdate.memoryIndex : { index: nextUpdate.memoryIndex },
              { formattingOptions: { insertSpaces: true, tabSize: 2 } },
            )
          : hasMemoryObject
            ? modify(updatedText, ['memory', 'index'], undefined, {
                formattingOptions: { insertSpaces: true, tabSize: 2 },
              })
            : [];
        if (memoryEdits.length > 0) {
          updatedText = applyEdits(updatedText, memoryEdits);
        }
      }
      if (nextUpdate.titleGeneratorProvided) {
        updatedText = applyEdits(updatedText, modify(
          updatedText,
          ['titleGenerator'],
          nextUpdate.titleGenerator,
          { formattingOptions: { insertSpaces: true, tabSize: 2 } },
        ));
      }
      if (nextUpdate.titleSystemPromptProvided) {
        updatedText = applyEdits(updatedText, modify(
          updatedText,
          ['systemPrompts'],
          Object.keys(nextUpdate.systemPrompts ?? {}).length > 0 ? nextUpdate.systemPrompts : undefined,
          { formattingOptions: { insertSpaces: true, tabSize: 2 } },
        ));
      }
      writeFileSync(configPath, updatedText, 'utf-8');
      options.config.models = nextUpdate.models;
      if (nextUpdate.memoryIndexProvided) {
        if (nextUpdate.memoryIndex) {
          options.config.memory = {
            ...(options.config.memory ?? {}),
            index: nextUpdate.memoryIndex,
          };
        } else if (options.config.memory) {
          delete options.config.memory.index;
        }
      }
      if (nextUpdate.titleGeneratorProvided) {
        if (nextUpdate.titleGenerator) options.config.titleGenerator = nextUpdate.titleGenerator;
        else delete options.config.titleGenerator;
      }
      if (nextUpdate.titleSystemPromptProvided) {
        if (Object.keys(nextUpdate.systemPrompts ?? {}).length > 0) options.config.systemPrompts = nextUpdate.systemPrompts;
        else delete options.config.systemPrompts;
        options.onSystemPromptOverridesUpdated?.(options.config.systemPrompts);
      }
      options.onModelsUpdated?.(nextUpdate.models);
      if (nextUpdate.memoryIndexProvided) {
        await options.onMemoryIndexUpdated?.(options.config.memory?.index);
      }
      res.json({
        models: redactModels(nextUpdate.models),
        memoryIndex: redactMemoryIndex(options.config.memory?.index ?? null),
        titleGenerator: titleGeneratorView(options.config),
        titleSystemPrompt: titleSystemPromptView(options.config),
        publicModelList: getPublicModelList(nextUpdate.models),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

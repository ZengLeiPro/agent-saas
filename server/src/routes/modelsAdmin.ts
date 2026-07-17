import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { getPublicModelList } from '../app/models.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, MemoryIndexAppConfig, ModelsConfig } from '../app/config.js';

export interface CreateModelsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  onModelsUpdated?: (models: ModelsConfig) => void;
  onMemoryIndexUpdated?: (memoryIndex: MemoryIndexAppConfig | undefined) => void | Promise<void>;
}

type ModelsAdminUpdate = {
  models: ModelsConfig;
  memoryIndex: MemoryIndexAppConfig | null;
  memoryIndexProvided: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 凭据脱敏（2026-07-18 平台管理员分层治理批次）：
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

  const parsed = parseAppConfig(merged);
  if (!parsed.models) throw new Error('models 未配置');
  return {
    models: parsed.models,
    memoryIndex: parsed.memory?.index ?? null,
    memoryIndexProvided,
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
      options.onModelsUpdated?.(nextUpdate.models);
      if (nextUpdate.memoryIndexProvided) {
        await options.onMemoryIndexUpdated?.(options.config.memory?.index);
      }
      res.json({
        models: redactModels(nextUpdate.models),
        memoryIndex: redactMemoryIndex(options.config.memory?.index ?? null),
        publicModelList: getPublicModelList(nextUpdate.models),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

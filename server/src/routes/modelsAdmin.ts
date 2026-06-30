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
      models: options.config.models,
      memoryIndex: options.config.memory?.index ?? null,
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
      nextUpdate = validateModelsUpdate(rawConfig, req.body);
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
        models: nextUpdate.models,
        memoryIndex: options.config.memory?.index ?? null,
        publicModelList: getPublicModelList(nextUpdate.models),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

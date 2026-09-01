import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MemoryIndexService } from '../memory/index/service.js';
import type { MemoryIndexConfig } from '../memory/index/types.js';
import type { AppConfig } from '../types/index.js';
import { serverLogger } from '../utils/logger.js';

export const SAFE_SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function loadSettingsEnv(path: string): Record<string, string> | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw.env || typeof raw.env !== 'object') return undefined;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    return env;
  } catch {
    return undefined;
  }
}

export function createMemoryIndexService(
  processCwd: string,
  memoryIndexConfig: NonNullable<NonNullable<AppConfig['memory']>['index']> | undefined,
  options: ConstructorParameters<typeof MemoryIndexService>[2] = {},
): MemoryIndexService | null {
  if (memoryIndexConfig?.enabled !== true) return null;
  if (!memoryIndexConfig.embedding.apiKey) {
    throw new Error('memory.index.embedding API Key 尚未解析');
  }

  const resolvedConfig: MemoryIndexConfig = {
    enabled: true,
    dbDir: resolve(processCwd, memoryIndexConfig.dbDir ?? 'data/memory-index'),
    embedding: {
      baseUrl: memoryIndexConfig.embedding.baseUrl,
      apiKey: memoryIndexConfig.embedding.apiKey,
      model: memoryIndexConfig.embedding.model,
      dimensions: memoryIndexConfig.embedding.dimensions,
    },
    chunking: {
      tokens: memoryIndexConfig.chunking?.tokens ?? 400,
      overlap: memoryIndexConfig.chunking?.overlap ?? 80,
    },
    search: {
      vectorWeight: memoryIndexConfig.search?.vectorWeight ?? 0.7,
      textWeight: memoryIndexConfig.search?.textWeight ?? 0.3,
      maxResults: memoryIndexConfig.search?.maxResults ?? 10,
      minScore: memoryIndexConfig.search?.minScore ?? 0.3,
    },
    temporalDecay: {
      enabled: memoryIndexConfig.temporalDecay?.enabled ?? false,
      halfLifeDays: memoryIndexConfig.temporalDecay?.halfLifeDays ?? 30,
    },
    sync: {
      debounceMs: memoryIndexConfig.sync?.debounceMs ?? 1500,
    },
  };

  return new MemoryIndexService(
    resolvedConfig,
    (msg) => serverLogger.info(`[memory-index] ${msg}`),
    options,
  );
}

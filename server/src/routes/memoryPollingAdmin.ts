import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, MemoryPollingConfig } from '../app/config.js';
import { MEMORY_POLL_DEFAULTS } from '../cron/memoryPoll.js';

export interface CreateMemoryPollingAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  onPollingUpdated?: (polling: MemoryPollingConfig) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format();
  } catch {
    throw new Error(`memory.polling.timezone: 无效的 IANA 时区 ${timezone}`);
  }
}

function validatePollingUpdate(currentRaw: unknown, body: unknown): MemoryPollingConfig {
  const rawRecord = isRecord(currentRaw) ? currentRaw : {};
  const currentMemory = isRecord(rawRecord.memory) ? rawRecord.memory : {};
  const bodyRecord = isRecord(body) ? body : {};
  if (!isRecord(bodyRecord.polling)) {
    throw new Error('memory.polling: 缺少轮询配置');
  }

  const parsed = parseAppConfig({
    ...rawRecord,
    memory: {
      ...currentMemory,
      polling: bodyRecord.polling,
    },
  });
  const polling = parsed.memory?.polling;
  if (!polling) throw new Error('memory.polling: 缺少轮询配置');

  const hour = polling.hour ?? MEMORY_POLL_DEFAULTS.hour;
  const hoursSpan = polling.hoursSpan ?? MEMORY_POLL_DEFAULTS.hoursSpan;
  if (hour + hoursSpan > 24) {
    throw new Error('memory.polling.hoursSpan: 触发窗口不能跨越次日 00:00');
  }
  validateTimezone(polling.timezone ?? MEMORY_POLL_DEFAULTS.timezone);

  if (polling.model && parsed.models) {
    const exists = parsed.models.groups.some((group) =>
      group.models.some((model) => `${group.id}/${model.id}` === polling.model),
    );
    if (!exists) throw new Error(`memory.polling.model: 模型 ${polling.model} 不存在`);
  }

  return polling;
}

function pollingView(config: AppConfig) {
  const configured = config.memory?.polling ?? null;
  return {
    polling: {
      enabled: configured?.enabled ?? false,
      hour: configured?.hour ?? MEMORY_POLL_DEFAULTS.hour,
      hoursSpan: configured?.hoursSpan ?? MEMORY_POLL_DEFAULTS.hoursSpan,
      timezone: configured?.timezone ?? MEMORY_POLL_DEFAULTS.timezone,
      lookbackHours: configured?.lookbackHours ?? MEMORY_POLL_DEFAULTS.lookbackHours,
      maxTurns: configured?.maxTurns ?? MEMORY_POLL_DEFAULTS.maxTurns,
      timeoutSeconds: configured?.timeoutSeconds ?? MEMORY_POLL_DEFAULTS.timeoutSeconds,
      model: configured?.model ?? null,
    },
    configured: configured !== null,
    defaultModel: config.models?.default ?? null,
  };
}

export function createMemoryPollingAdminRouter(
  options: CreateMemoryPollingAdminRouterOptions,
): Router {
  const router = Router();
  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json(pollingView(options.config));
  });

  router.put('/', async (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let configText: string;
    let rawConfig: unknown;
    let polling: MemoryPollingConfig;

    try {
      configText = readFileSync(configPath, 'utf-8');
      rawConfig = parseJsonc(configText);
      polling = validatePollingUpdate(rawConfig, req.body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      const rawRecord = isRecord(rawConfig) ? rawConfig : {};
      const hasMemoryObject = isRecord(rawRecord.memory);
      const edits = modify(
        configText,
        hasMemoryObject ? ['memory', 'polling'] : ['memory'],
        hasMemoryObject ? polling : { polling },
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      );
      const updatedText = applyEdits(configText, edits);
      writeFileSync(configPath, updatedText, 'utf-8');
      options.config.memory = {
        ...(options.config.memory ?? {}),
        polling,
      };
      await options.onPollingUpdated?.(polling);
      res.json(pollingView(options.config));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

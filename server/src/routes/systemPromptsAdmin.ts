import { readFileSync, writeFileSync } from 'node:fs';

import { parse as parseJsonc, applyEdits, modify } from 'jsonc-parser';
import { Router } from 'express';
import { z } from 'zod';

import {
  getAppConfigPath,
  parseAppConfig,
  type AppConfig,
} from '../app/config.js';
import { requireSuperAdmin } from '../auth/platformGovernance.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import {
  SystemPromptRegistry,
  isSystemPromptId,
  type SystemPromptOverrides,
} from '../runtime/systemPrompts.js';

const updateBodySchema = z.object({
  content: z.string().trim().min(1, '系统提示语不能为空').max(200_000, '系统提示语不能超过 200000 字符'),
}).strict();

export interface CreateSystemPromptsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  registry: SystemPromptRegistry;
}

export function createSystemPromptsAdminRouter(
  options: CreateSystemPromptsAdminRouterOptions,
): Router {
  const router = Router();
  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json({ prompts: options.registry.list() });
  });

  router.put('/:promptId', requireSuperAdmin, (req, res) => {
    const promptId = req.params.promptId;
    if (!isSystemPromptId(promptId)) {
      res.status(404).json({ error: '未知系统提示语类型' });
      return;
    }
    const parsedBody = updateBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.issues.map((issue) => issue.message).join('; ') });
      return;
    }

    try {
      const next = {
        ...(options.config.systemPrompts ?? {}),
        [promptId]: parsedBody.data.content,
      } satisfies SystemPromptOverrides;
      persist(options, next);
      res.json({ prompts: options.registry.list() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/:promptId', requireSuperAdmin, (req, res) => {
    const promptId = req.params.promptId;
    if (!isSystemPromptId(promptId)) {
      res.status(404).json({ error: '未知系统提示语类型' });
      return;
    }

    try {
      const next = { ...(options.config.systemPrompts ?? {}) };
      delete next[promptId];
      persist(options, next);
      res.json({ prompts: options.registry.list() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

function persist(
  options: CreateSystemPromptsAdminRouterOptions,
  nextOverrides: SystemPromptOverrides,
): void {
  const configPath = getAppConfigPath(options.processCwd);
  const configText = readFileSync(configPath, 'utf-8');
  const rawConfig = parseJsonc(configText);
  if (!isRecord(rawConfig)) throw new Error('config.json 根节点必须是对象');

  const hasOverrides = Object.keys(nextOverrides).length > 0;
  const nextRaw = { ...rawConfig };
  if (hasOverrides) nextRaw.systemPrompts = nextOverrides;
  else delete nextRaw.systemPrompts;
  const parsedConfig = parseAppConfig(nextRaw);

  const updatedText = applyEdits(configText, modify(
    configText,
    ['systemPrompts'],
    hasOverrides ? parsedConfig.systemPrompts : undefined,
    { formattingOptions: { insertSpaces: true, tabSize: 2 } },
  ));
  writeFileSync(configPath, updatedText, 'utf-8');

  if (parsedConfig.systemPrompts) options.config.systemPrompts = parsedConfig.systemPrompts;
  else delete options.config.systemPrompts;
  options.registry.replaceOverrides(parsedConfig.systemPrompts ?? {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

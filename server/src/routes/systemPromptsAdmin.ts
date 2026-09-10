import { applyEdits, modify } from 'jsonc-parser';
import { Router, type Request } from 'express';
import { z } from 'zod';

import {
  parseAppConfig,
  type AppConfig,
} from '../app/config.js';
import { getAppConfigPath } from '../app/config.js';
import { requireSuperAdmin } from '../auth/platformGovernance.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import {
  SystemPromptRegistry,
  isSystemPromptId,
  type SystemPromptId,
  type SystemPromptOverrides,
} from '../runtime/systemPrompts.js';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import {
  adminConfigReadMetadata,
  mutationBusinessBody,
  mutationRequestContext,
  sendConfigMutationError,
} from '../config/adminConfigMutationHttp.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';

const updateBodySchema = z.object({
  content: z.string().trim().min(1, '系统提示语不能为空').max(200_000, '系统提示语不能超过 200000 字符'),
}).strict();

export interface CreateSystemPromptsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  registry: SystemPromptRegistry;
  configMutationService?: AdminConfigMutationService;
}

export function createSystemPromptsAdminRouter(
  options: CreateSystemPromptsAdminRouterOptions,
): Router {
  const router = Router();
  const configMutationService = options.configMutationService ?? new AdminConfigMutationService({
    configPath: getAppConfigPath(options.processCwd),
    processCwd: options.processCwd,
    environment: readRuntimeIdentity().environment,
    processRole: 'all',
  });
  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...adminConfigReadMetadata(options.processCwd, configMutationService),
      prompts: options.registry.list(),
    });
  });

  router.put('/:promptId', requireSuperAdmin, async (req, res) => {
    const promptId = req.params.promptId;
    if (!isSystemPromptId(promptId)) {
      res.status(404).json({ error: '未知系统提示语类型' });
      return;
    }
    const parsedBody = updateBodySchema.safeParse(mutationBusinessBody(req));
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.issues.map((issue) => issue.message).join('; ') });
      return;
    }

    try {
      await persist(options, configMutationService, req, {
        promptId,
        action: 'set',
        content: parsedBody.data.content,
      });
      res.json({
        ...adminConfigReadMetadata(options.processCwd, configMutationService),
        prompts: options.registry.list(),
      });
    } catch (error) {
      sendConfigMutationError(res, error);
    }
  });

  router.delete('/:promptId', requireSuperAdmin, async (req, res) => {
    const promptId = req.params.promptId;
    if (!isSystemPromptId(promptId)) {
      res.status(404).json({ error: '未知系统提示语类型' });
      return;
    }

    try {
      await persist(options, configMutationService, req, { promptId, action: 'reset' });
      res.json({
        ...adminConfigReadMetadata(options.processCwd, configMutationService),
        prompts: options.registry.list(),
      });
    } catch (error) {
      sendConfigMutationError(res, error);
    }
  });

  return router;
}

async function persist(
  options: CreateSystemPromptsAdminRouterOptions,
  configMutationService: AdminConfigMutationService,
  req: Request,
  command:
    | { promptId: SystemPromptId; action: 'set'; content: string }
    | { promptId: SystemPromptId; action: 'reset' },
): Promise<void> {
  await configMutationService.mutate({
    ...mutationRequestContext(req),
    operation: {
      id: command.action === 'set' ? 'system-prompts.set' : 'system-prompts.reset',
      target: command.promptId,
    },
    changedPaths: [`systemPrompts.${command.promptId}`],
    buildCandidate: (configText, rawConfig) => {
      const current = parseAppConfig(rawConfig).systemPrompts ?? {};
      const nextOverrides: SystemPromptOverrides = { ...current };
      if (command.action === 'set') nextOverrides[command.promptId] = command.content;
      else delete nextOverrides[command.promptId];
      const hasOverrides = Object.keys(nextOverrides).length > 0;
      const nextRaw = { ...rawConfig };
      if (hasOverrides) nextRaw.systemPrompts = nextOverrides;
      else delete nextRaw.systemPrompts;
      const parsedConfig = parseAppConfig(nextRaw);
      return applyEdits(configText, modify(
        configText,
        ['systemPrompts'],
        hasOverrides ? parsedConfig.systemPrompts : undefined,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      ));
    },
    applyRuntime: (candidate) => {
      if (candidate.systemPrompts) options.config.systemPrompts = candidate.systemPrompts;
      else delete options.config.systemPrompts;
      options.registry.replaceOverrides(candidate.systemPrompts ?? {});
    },
  });
}

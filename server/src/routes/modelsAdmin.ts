import { Router } from 'express';
import { applyEdits, modify } from 'jsonc-parser';

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
import {
  AdminConfigMutationService,
  ConfigConflictError,
} from '../config/adminConfigMutationService.js';
import { mutationRequestContext, sendConfigMutationError } from '../config/adminConfigMutationHttp.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import { GLOBAL_OWNER_ID, type SecretVault } from '../security/secretVault.js';

export interface CreateModelsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  onModelsUpdated?: (models: ModelsConfig) => void | Promise<void>;
  onMemoryIndexUpdated?: (memoryIndex: MemoryIndexAppConfig | undefined) => void | Promise<void>;
  onSystemPromptOverridesUpdated?: (next: SystemPromptsConfig) => void;
  configMutationService?: AdminConfigMutationService;
  secretVault?: SecretVault;
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
      const { apiKey, apiKeyRef: _apiKeyRef, ...rest } = group;
      return { ...rest, hasApiKey: Boolean(apiKey || group.apiKeyRef) };
    }),
  };
}

function redactMemoryIndex(memoryIndex: MemoryIndexAppConfig | null): unknown {
  if (!memoryIndex) return null;
  const { apiKey, apiKeyRef: _apiKeyRef, ...restEmbedding } = memoryIndex.embedding;
  return {
    ...memoryIndex,
    embedding: {
      ...restEmbedding,
      hasApiKey: Boolean(apiKey || memoryIndex.embedding.apiKeyRef),
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
      (config.models?.groups ?? []).map((g) => [g.id, { apiKey: g.apiKey, apiKeyRef: g.apiKeyRef }]),
    );
    next.models = {
      ...modelsRecord,
      groups: (modelsRecord.groups as unknown[]).map((groupRaw) => {
        if (!isRecord(groupRaw)) return groupRaw;
        const { hasApiKey: _ignored, ...group } = groupRaw;
        const inlineKey = typeof group.apiKey === 'string' ? group.apiKey : undefined;
        if (inlineKey && inlineKey.length > 0) return group;
        const currentCredential = typeof group.id === 'string' ? currentByGroupId.get(group.id) : undefined;
        if (currentCredential?.apiKeyRef) return { ...group, apiKeyRef: currentCredential.apiKeyRef };
        if (currentCredential?.apiKey) return { ...group, apiKey: currentCredential.apiKey };
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
      const currentEmbedding = config.memory?.index?.embedding;
      if (currentEmbedding?.apiKeyRef) {
        next.memoryIndex = { ...next.memoryIndex, embedding: { ...embedding, apiKeyRef: currentEmbedding.apiKeyRef } };
      } else if (currentEmbedding?.apiKey) {
        next.memoryIndex = { ...next.memoryIndex, embedding: { ...embedding, apiKey: currentEmbedding.apiKey } };
      } else {
        next.memoryIndex = { ...next.memoryIndex, embedding };
      }
    } else {
      next.memoryIndex = { ...next.memoryIndex, embedding };
    }
  }

  return next;
}

function submittedModelApiKeyGroups(body: unknown, current: AppConfig): Set<string> {
  if (!isRecord(body) || !isRecord(body.models) || !Array.isArray(body.models.groups)) return new Set();
  return new Set(body.models.groups.flatMap((value) => (
    isRecord(value)
      && typeof value.id === 'string'
      && typeof value.apiKey === 'string'
      && value.apiKey.trim()
      && current.models?.groups.find((group) => group.id === value.id)?.apiKey !== value.apiKey
      ? [value.id]
      : []
  )));
}

async function persistSubmittedModelCredentials(input: {
  models: ModelsConfig;
  submittedGroups: Set<string>;
  secretVault?: SecretVault;
  actor: string;
  createdRefs: CreatedSecretRef[];
  replacedRefs: CreatedSecretRef[];
  previousRefs: Map<string, string | undefined>;
}): Promise<ModelsConfig> {
  return {
    ...input.models,
    groups: await Promise.all(input.models.groups.map(async (group) => {
      if (!input.submittedGroups.has(group.id) || !group.apiKey) return group;
      if (!input.secretVault) throw new Error('SecretVault 未配置，不能保存模型 API Key');
      const ref = await input.secretVault.putSecret(
        GLOBAL_OWNER_ID,
        'models',
        group.apiKey,
        { actor: 'system', userId: 'models_config_admin', scopes: ['secret:models:write'] },
        { groupId: group.id, purpose: 'model-api' },
      );
      input.createdRefs.push({ ref: ref.id, kind: 'models' });
      const previousRef = input.previousRefs.get(group.id);
      if (previousRef && previousRef !== ref.id) input.replacedRefs.push({ ref: previousRef, kind: 'models' });
      const { apiKey: _apiKey, ...safe } = group;
      return { ...safe, apiKeyRef: ref.id };
    })),
  };
}

type CreatedSecretRef = { ref: string; kind: 'models' | 'memory_index' };

async function persistSubmittedMemoryCredential(input: {
  memoryIndex: MemoryIndexAppConfig | null;
  body: unknown;
  current: AppConfig;
  secretVault?: SecretVault;
  createdRefs: CreatedSecretRef[];
  replacedRefs: CreatedSecretRef[];
}): Promise<MemoryIndexAppConfig | null> {
  if (!input.memoryIndex || !isRecord(input.body) || !isRecord(input.body.memoryIndex)) return input.memoryIndex;
  const requested = input.body.memoryIndex;
  if (!isRecord(requested.embedding) || typeof requested.embedding.apiKey !== 'string' || !requested.embedding.apiKey.trim()) {
    return input.memoryIndex;
  }
  if (requested.embedding.apiKey === input.current.memory?.index?.embedding.apiKey) return input.memoryIndex;
  if (!input.secretVault) throw new Error('SecretVault 未配置，不能保存 Memory Embedding API Key');
  const ref = await input.secretVault.putSecret(
    GLOBAL_OWNER_ID,
    'memory_index',
    requested.embedding.apiKey,
    { actor: 'system', userId: 'models_config_admin', scopes: ['secret:memory_index:write'] },
    { purpose: 'memory-embedding' },
  );
  input.createdRefs.push({ ref: ref.id, kind: 'memory_index' });
  const previousRef = input.current.memory?.index?.embedding.apiKeyRef;
  if (previousRef && previousRef !== ref.id) input.replacedRefs.push({ ref: previousRef, kind: 'memory_index' });
  const { apiKey: _apiKey, ...embedding } = input.memoryIndex.embedding;
  return { ...input.memoryIndex, embedding: { ...embedding, apiKeyRef: ref.id } };
}

async function revokeModelRefs(vault: SecretVault | undefined, refs: CreatedSecretRef[]): Promise<void> {
  if (!vault) return;
  await Promise.all(refs.map((item) => vault.revokeSecret(item.ref, {
    actor: 'system',
    userId: 'models_config_admin',
    scopes: [`secret:${item.kind}:revoke`],
  }).catch(() => undefined)));
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
  const configMutationService = options.configMutationService ?? new AdminConfigMutationService({
    configPath: getAppConfigPath(options.processCwd),
    processCwd: options.processCwd,
    environment: readRuntimeIdentity().environment,
    processRole: 'all',
  });

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
    let nextUpdate: ModelsAdminUpdate;
    const createdRefs: CreatedSecretRef[] = [];
    const replacedRefs: CreatedSecretRef[] = [];
    const requestContext = mutationRequestContext(req);
    try {
      const result = await configMutationService.mutate({
        ...requestContext,
        changedPaths: ['models', 'memory.index', 'titleGenerator', 'systemPrompts.utility.title'],
        buildCandidate: async (configText, rawConfig) => {
          const persisted = parseAppConfig(rawConfig);
          nextUpdate = validateModelsUpdate(rawConfig, restoreSecrets(req.body, persisted));
          nextUpdate = {
            ...nextUpdate,
            models: await persistSubmittedModelCredentials({
              models: nextUpdate.models,
              submittedGroups: submittedModelApiKeyGroups(req.body, persisted),
              secretVault: options.secretVault,
              actor: requestContext.actor,
              createdRefs,
              replacedRefs,
              previousRefs: new Map((persisted.models?.groups ?? []).map((group) => [group.id, group.apiKeyRef])),
            }),
          };
          nextUpdate = {
            ...nextUpdate,
            memoryIndex: await persistSubmittedMemoryCredential({
              memoryIndex: nextUpdate.memoryIndex,
              body: req.body,
              current: persisted,
              secretVault: options.secretVault,
              createdRefs,
              replacedRefs,
            }),
          };
          let updatedText = applyEdits(configText, modify(configText, ['models'], nextUpdate.models, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }));
          if (nextUpdate.memoryIndexProvided) {
            const hasMemoryObject = isRecord(rawConfig.memory);
            const memoryEdits = nextUpdate.memoryIndex
              ? modify(updatedText, hasMemoryObject ? ['memory', 'index'] : ['memory'], hasMemoryObject ? nextUpdate.memoryIndex : { index: nextUpdate.memoryIndex }, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
              : hasMemoryObject ? modify(updatedText, ['memory', 'index'], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }) : [];
            if (memoryEdits.length > 0) updatedText = applyEdits(updatedText, memoryEdits);
          }
          if (nextUpdate.titleGeneratorProvided) updatedText = applyEdits(updatedText, modify(updatedText, ['titleGenerator'], nextUpdate.titleGenerator, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
          if (nextUpdate.titleSystemPromptProvided) updatedText = applyEdits(updatedText, modify(updatedText, ['systemPrompts'], Object.keys(nextUpdate.systemPrompts ?? {}).length > 0 ? nextUpdate.systemPrompts : undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
          return updatedText;
        },
        applyRuntime: async (candidate) => {
          if (!candidate.models) throw new Error('models 未配置');
          options.config.models = candidate.models;
          if (candidate.memory) options.config.memory = candidate.memory;
          else delete options.config.memory;
          if (candidate.titleGenerator) options.config.titleGenerator = candidate.titleGenerator;
          else delete options.config.titleGenerator;
          if (candidate.systemPrompts) options.config.systemPrompts = candidate.systemPrompts;
          else delete options.config.systemPrompts;
          await options.onModelsUpdated?.(candidate.models);
          await options.onMemoryIndexUpdated?.(candidate.memory?.index);
          options.onSystemPromptOverridesUpdated?.(candidate.systemPrompts ?? {});
        },
      });
      await revokeModelRefs(options.secretVault, replacedRefs);
      res.setHeader('ETag', `"${result.rawConfigFingerprint}"`);
      res.json({
        models: redactModels(result.config.models!),
        memoryIndex: redactMemoryIndex(options.config.memory?.index ?? null),
        titleGenerator: titleGeneratorView(options.config),
        titleSystemPrompt: titleSystemPromptView(options.config),
        publicModelList: getPublicModelList(result.config.models!),
      });
    } catch (error) {
      await revokeModelRefs(options.secretVault, createdRefs);
      if (error instanceof Error && !(error instanceof ConfigConflictError)) {
        // Validation failures remain client errors; mutation/readback failures use the shared handler.
        if (/models|memory|标题|提示语|配置/u.test(error.message)) {
          res.status(400).json({ error: error.message });
          return;
        }
      }
      sendConfigMutationError(res, error);
    }
  });

  return router;
}

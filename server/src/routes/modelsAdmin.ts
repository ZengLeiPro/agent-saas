import { readFileSync } from 'node:fs';
import { Router, type Response } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { TITLE_SYSTEM_PROMPT } from '../agent/titleGenerator.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import { getPublicModelList } from '../app/models.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import { configRevision } from './configWriteLock.js';
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
  ConfigMutationCommittedError,
  RuntimeRestoreFailedError,
  configFingerprint,
} from '../config/adminConfigMutationService.js';
import { mutationRequestContext, sendConfigMutationError } from '../config/adminConfigMutationHttp.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import { guardrailForModelsUpdate, validateGuardrailModels } from './modelsAdminGuardrail.js';
import { GLOBAL_OWNER_ID, type SecretVault } from '../security/secretVault.js';
import {
  assertQuotaSourcesComplete,
  persistSubmittedQuotaSecrets,
  redactGroupQuotaSource,
  restoreGroupQuotaSourceSecret,
  submittedQuotaSecretGroups,
} from './modelsAdminQuotaSource.js';

export interface CreateModelsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  onModelsUpdated?: (models: ModelsConfig) => void | Promise<void>;
  onMemoryIndexUpdated?: (memoryIndex: MemoryIndexAppConfig | undefined) => void | Promise<void>;
  onSystemPromptOverridesUpdated?: (next: SystemPromptsConfig) => void;
  configMutationService?: AdminConfigMutationService;
  secretVault?: SecretVault;
  validateConfigReload?: (next: AppConfig) => void | Promise<void>;
  /** 兼容两阶段直写调用方；集中式 mutation service 路径由 applyRuntime 接管。 */
  prepareConfigUpdate?: (next: AppConfig) => () => void;
  onConfigReloaded?: (expectedConfigText: string) => void | Promise<void>;
  requireRevision?: boolean;
  ensureConfigBaselineApplied?: (expectedText: string) => Promise<boolean>;
}

class RuntimeConfigValidationError extends Error {}

function sendRevisionMutationError(res: Response, error: unknown): void {
  if (error instanceof ConfigConflictError && error.currentRevision) {
    res.setHeader('ETag', `"${error.currentRevision}"`);
    res.status(409).json({ error: error.message, code: error.code, revision: error.currentRevision });
    return;
  }
  sendConfigMutationError(res, error);
}

type ModelsAdminUpdate = {
  candidateConfig: AppConfig;
  models: ModelsConfig;
  memoryIndex: MemoryIndexAppConfig | null;
  memoryIndexProvided: boolean;
  titleGenerator: TitleGeneratorAppConfig | undefined;
  titleGeneratorProvided: boolean;
  guardrail: AppConfig['guardrail'];
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
      const { apiKey, apiKeyRef: _apiKeyRef, ...rest } = redactGroupQuotaSource(group);
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

// 辅助模型主链与全部 fallback 必须随 models 候选一起验证，避免写盘后才派生失败。
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
      groups: (modelsRecord.groups as unknown[]).map((groupRawInput) => {
        if (!isRecord(groupRawInput)) return groupRawInput;
        const groupRaw = restoreGroupQuotaSourceSecret(
          groupRawInput,
          typeof groupRawInput.id === 'string' ? config.models?.groups.find((g) => g.id === groupRawInput.id) : undefined,
        );
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
    if (!inlineKey || inlineKey.trim().length === 0) {
      delete embedding.apiKey;
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
  allowInlineWithoutVault?: boolean;
}): Promise<ModelsConfig> {
  const groups: ModelsConfig['groups'] = [];
  for (const group of input.models.groups) {
    if (!input.submittedGroups.has(group.id) || !group.apiKey) {
      groups.push(group);
      continue;
    }
    if (!input.secretVault) {
      if (input.allowInlineWithoutVault) {
        groups.push(group);
        continue;
      }
      throw new Error('SecretVault 未配置，不能保存模型 API Key');
    }
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
    groups.push({ ...safe, apiKeyRef: ref.id });
  }
  return { ...input.models, groups };
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

function unreferencedReplacedRefs(config: AppConfig, refs: CreatedSecretRef[]): CreatedSecretRef[] {
  const referenced = new Set([
    ...(config.models?.groups.flatMap((group) => group.apiKeyRef ? [`models\0${group.apiKeyRef}`] : []) ?? []),
    ...(config.memory?.index?.embedding.apiKeyRef ? [`memory_index\0${config.memory.index.embedding.apiKeyRef}`] : []),
  ]);
  return [...new Map(
    refs
      .filter((item) => !referenced.has(`${item.kind}\0${item.ref}`))
      .map((item) => [`${item.kind}\0${item.ref}`, item]),
  ).values()];
}

/** 去重撤销并返回失败；调用方按提交前/后阶段决定回滚或报告维护失败。 */
async function revokeModelRefs(vault: SecretVault | undefined, refs: CreatedSecretRef[]): Promise<unknown[]> {
  if (!vault) return [];
  const outcomes = await Promise.allSettled(refs.map((item) => vault.revokeSecret(item.ref, {
    actor: 'system',
    userId: 'models_config_admin',
    scopes: [`secret:${item.kind}:revoke`],
  })));
  return outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
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
  if (Object.prototype.hasOwnProperty.call(bodyRecord, 'guardrail')) merged.guardrail = bodyRecord.guardrail;

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

  const current = parseAppConfig(rawRecord);
  const candidate = parseAppConfig(merged);
  if (candidate.models) merged.guardrail = guardrailForModelsUpdate(current, candidate.models, candidate.guardrail);
  const parsed = parseAppConfig(merged);
  if (!parsed.models) throw new Error('models 未配置');
  validateTitleGeneratorModels(parsed.models, parsed.titleGenerator);
  validateGuardrailModels(parsed.models, parsed.guardrail);
  assertQuotaSourcesComplete(parsed.models);
  return {
    candidateConfig: parsed,
    models: parsed.models,
    memoryIndex: parsed.memory?.index ?? null,
    memoryIndexProvided,
    titleGenerator: parsed.titleGenerator,
    titleGeneratorProvided,
    guardrail: parsed.guardrail,
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
    const configText = readFileSync(getAppConfigPath(options.processCwd), 'utf-8');
    const diskConfig = parseAppConfig(parseJsonc(configText));
    if (!diskConfig.models) { res.status(404).json({ error: 'models 未配置' }); return; }
    const revision = configRevision(configText);
    res.setHeader('ETag', `"${revision}"`);
    res.json({
      revision,
      models: redactModels(diskConfig.models),
      memoryIndex: redactMemoryIndex(diskConfig.memory?.index ?? null),
      titleGenerator: titleGeneratorView(diskConfig),
      guardrail: diskConfig.guardrail ?? null,
      titleSystemPrompt: titleSystemPromptView(diskConfig),
      publicModelList: getPublicModelList(diskConfig.models),
    });
  });

  router.put('/', async (req, res) => {
    let nextUpdate: ModelsAdminUpdate;
    const createdRefs: CreatedSecretRef[] = [];
    const replacedRefs: CreatedSecretRef[] = [];
    const requestContext = mutationRequestContext(req);
    const expectedRevisions = [
      typeof req.body?.expectedRevision === 'string' ? req.body.expectedRevision : undefined,
      requestContext.expectedFingerprint,
    ].filter((revision): revision is string => Boolean(revision));
    try {
      const result = await configMutationService.mutate({
        actor: requestContext.actor,
        expectedRevision: expectedRevisions[0],
        changedPaths: ['models', 'memory.index', 'titleGenerator', 'guardrail', 'systemPrompts.utility.title'],
        validateBaseline: async (configText, _current) => {
          const revision = configRevision(configText);
          if ((options.requireRevision && expectedRevisions.length === 0) || expectedRevisions.some((expected) => expected !== revision)) {
            throw new ConfigConflictError(configFingerprint(parseJsonc(configText)), revision);
          }
          if (options.ensureConfigBaselineApplied && !await options.ensureConfigBaselineApplied(configText)) {
            throw new Error('当前配置基线未完整应用，拒绝写入');
          }
        },
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
              allowInlineWithoutVault: Boolean(options.validateConfigReload),
            }),
          };
          nextUpdate = {
            ...nextUpdate,
            models: await persistSubmittedQuotaSecrets({
              models: nextUpdate.models,
              submittedGroups: submittedQuotaSecretGroups(req.body, persisted.models),
              secretVault: options.secretVault,
              createdRefs,
              replacedRefs,
              previousRefs: new Map((persisted.models?.groups ?? []).map((group) => [group.id, group.quotaSource?.secretAccessKeyRef])),
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
          if (nextUpdate.guardrail) updatedText = applyEdits(updatedText, modify(updatedText, ['guardrail'], nextUpdate.guardrail, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
          if (nextUpdate.titleSystemPromptProvided) updatedText = applyEdits(updatedText, modify(updatedText, ['systemPrompts'], Object.keys(nextUpdate.systemPrompts ?? {}).length > 0 ? nextUpdate.systemPrompts : undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
          return updatedText;
        },
        ...(options.validateConfigReload
          ? {
              validateCandidate: async (candidate: AppConfig) => {
                try {
                  await options.validateConfigReload?.(candidate);
                } catch (error) {
                  throw new RuntimeConfigValidationError(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              },
            }
          : {}),
        applyRuntime: async (candidate) => {
          if (!candidate.models) throw new Error('models 未配置');
          const commitPreparedConfig = options.prepareConfigUpdate?.(candidate);
          commitPreparedConfig?.();
          options.config.models = candidate.models;
          if (candidate.memory) options.config.memory = candidate.memory;
          else delete options.config.memory;
          if (candidate.titleGenerator) options.config.titleGenerator = candidate.titleGenerator;
          else delete options.config.titleGenerator;
          if (candidate.guardrail) options.config.guardrail = candidate.guardrail;
          else delete options.config.guardrail;
          if (candidate.systemPrompts) options.config.systemPrompts = candidate.systemPrompts;
          else delete options.config.systemPrompts;
          if (!commitPreparedConfig) {
            await options.onModelsUpdated?.(candidate.models);
            options.onSystemPromptOverridesUpdated?.(candidate.systemPrompts ?? {});
          }
          await options.onMemoryIndexUpdated?.(candidate.memory?.index);
        },
        ...(options.onConfigReloaded ? { onCommitted: options.onConfigReloaded } : {}),
      });
      const pruneErrors = await revokeModelRefs(
        options.secretVault,
        unreferencedReplacedRefs(result.config, replacedRefs),
      );
      if (pruneErrors.length > 0) {
        throw new ConfigMutationCommittedError(
          new AggregateError(pruneErrors, '配置已提交，但旧模型凭据撤销失败'),
        );
      }
      // ETag is the raw-text CAS revision; rawConfigFingerprint remains a separate governance identity.
      res.setHeader('ETag', `"${result.revision}"`);
      res.json({
        revision: result.revision,
        models: redactModels(result.config.models!),
        memoryIndex: redactMemoryIndex(options.config.memory?.index ?? null),
        titleGenerator: titleGeneratorView(options.config),
        guardrail: options.config.guardrail ?? null,
        titleSystemPrompt: titleSystemPromptView(options.config),
        publicModelList: getPublicModelList(result.config.models!),
      });
    } catch (error) {
      let cleanupErrors: unknown[] = [];
      if (error instanceof ConfigMutationCommittedError) {
        // durable/runtime 已提交；只撤销最终配置中已无任何引用的旧 refs。
        cleanupErrors = await revokeModelRefs(
          options.secretVault,
          unreferencedReplacedRefs(options.config, replacedRefs),
        );
      } else if (!(error instanceof RuntimeRestoreFailedError)) {
        // 提交前失败或完整回滚：候选 refs 无人引用，旧 refs 仍需保留。
        cleanupErrors = await revokeModelRefs(options.secretVault, createdRefs);
      }
      if (cleanupErrors.length > 0) {
        sendRevisionMutationError(res, error instanceof ConfigMutationCommittedError
          ? error
          : new AggregateError(
              [error, ...cleanupErrors],
              '配置变更失败，且候选模型凭据撤销失败',
            ));
        return;
      }
      if (error instanceof RuntimeConfigValidationError) {
        sendConfigMutationError(res, error);
        return;
      }
      if (
        error instanceof Error
        && !(error instanceof ConfigConflictError)
        && !(error instanceof ConfigMutationCommittedError)
        && !(error instanceof RuntimeRestoreFailedError)
      ) {
        // 仅提交前候选校验属于 client error；已提交/恢复失败必须走服务端错误。
        if (/models|memory|标题|提示语|配置|门禁模型/u.test(error.message)) {
          res.status(400).json({ error: error.message });
          return;
        }
      }
      // 配置已提交但维护失败必须保留 5xx，提示调用方重新读取服务端状态与凭据状态。
      sendRevisionMutationError(res, error);
    }
  });

  return router;
}

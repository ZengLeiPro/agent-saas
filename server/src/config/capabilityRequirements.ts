import { isToolEnabled } from '../agent/toolRuntime.js';
import type { AppConfig, ModelsConfig } from '../app/config.js';
import { isTtsCapabilityEnabled } from '../integrations/tts/capability.js';
import { MEMORY_CONSOLIDATION_DEFAULTS } from '../memory/consolidation/types.js';

import {
  CAPABILITY_BLOCKER_CODES,
  CAPABILITY_TARGET_ROUTES,
  type CapabilityBlocker,
  type CapabilityId,
  type CapabilityReadiness,
} from './capabilityContract.js';

/**
 * 每项能力的「启用前必须齐备」判定。
 *
 * 这里只回答两个问题：当前是否已经启用、以及要达到可启用状态还缺什么。
 * 真实上游探测（模型调用、搜索出口、OSS 读写、Sandbox canary 等）属于各能力
 * 自己的启用验证器，不在本模块内实现；配置格式合法不等于运行就绪。
 *
 * `missing` 只放管理员能在浏览器里补齐的配置字段路径；依赖别的能力、运行存储
 * 后端不匹配、参数组合自相矛盾这类问题走 `blockers`。
 */

export interface CapabilityDraft {
  enabled: boolean;
  missing: string[];
  blockers: CapabilityBlocker[];
}

export interface CapabilityEvaluationContext {
  config: AppConfig;
  /**
   * 第二轮评估可见的前序能力就绪状态。必须是已经并入验证记录的最终 state，
   * 否则工具控制会把「探测失败的依赖」当成可用。
   */
  dependencies: ReadonlyMap<CapabilityId, CapabilityReadiness>;
}

type CapabilityEvaluator = (context: CapabilityEvaluationContext) => CapabilityDraft;

/** 依赖其他能力结果的能力，必须放到第二轮评估。 */
export const DEPENDENT_CAPABILITY_IDS: readonly CapabilityId[] = ['toolControls'];

function draft(
  enabled: boolean,
  missing: string[] = [],
  blockers: CapabilityBlocker[] = [],
): CapabilityDraft {
  return { enabled, missing, blockers };
}

function configured(...values: Array<string | undefined | null>): boolean {
  return values.some((value) => typeof value === 'string' && value.trim().length > 0);
}

function dependencyBlocker(message: string, capability: CapabilityId): CapabilityBlocker {
  const targetRouteId = CAPABILITY_TARGET_ROUTES[capability];
  return {
    code: CAPABILITY_BLOCKER_CODES.dependencyDisabled,
    message,
    ...(targetRouteId ? { targetRouteId } : {}),
  };
}

function parameterBlocker(message: string): CapabilityBlocker {
  return { code: CAPABILITY_BLOCKER_CODES.invalidParameterCombination, message };
}

function eventStoreBlocker(message: string): CapabilityBlocker {
  return { code: CAPABILITY_BLOCKER_CODES.runtimeStoreUnsupported, message };
}

function isPostgresEventStore(config: AppConfig): boolean {
  return config.runtimeEventStore?.backend === 'pg';
}

/** `groupId/modelId` 引用是否落在已配置的模型上；与 resolveModelRefStrict 同一套语义。 */
function findConfiguredModel(models: ModelsConfig | undefined, ref: string | undefined): boolean {
  if (!models || !ref) return false;
  const separator = ref.indexOf('/');
  if (separator < 0) return false;
  const group = models.groups.find((item) => item.id === ref.slice(0, separator));
  return Boolean(group?.models.some((item) => item.id === ref.slice(separator + 1)));
}

function hasCodexTransportModel(models: ModelsConfig | undefined): boolean {
  return (models?.groups ?? []).some((group) =>
    group.models.some(
      (model) => (model.responses_transport ?? group.responses_transport) === 'codex_subscription',
    ),
  );
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/iu;

function evaluateModels({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const models = config.models;
  const missing: string[] = [];
  if (!models || models.groups.length === 0) {
    missing.push('models.groups');
  } else {
    if (!findConfiguredModel(models, models.default)) missing.push('models.default');
    const imageUnderstanding = models.imageUnderstanding?.model;
    if (imageUnderstanding && !findConfiguredModel(models, imageUnderstanding)) {
      missing.push('models.imageUnderstanding.model');
    }
  }
  // 模型没有独立总开关：配置出至少一个可解析的模型即视为已启用（方案 §5.1）。
  return draft(Boolean(models?.groups.length), missing);
}

function evaluateCodex({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const codex = config.codexSubscription;
  const missing: string[] = [];
  const accounts = codex?.credentialRefs?.length ?? (configured(codex?.credentialRef) ? 1 : 0);
  if (accounts === 0) missing.push('codexSubscription.credentialRefs');
  const blockers: CapabilityBlocker[] = [];
  if (!hasCodexTransportModel(config.models)) {
    blockers.push(
      dependencyBlocker('缺少 transport 为 codex_subscription 的 Responses 模型', 'models'),
    );
  }
  return draft(codex?.enabled === true, missing, blockers);
}

function evaluateWebTools({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const search = config.webTools?.search;
  const fetch = config.webTools?.fetch;
  // 与 listConfiguredWebToolNames 保持一致：search 段缺失即未启用，fetch 段缺失按启用处理。
  const searchActive = Boolean(search) && search?.enabled !== false;
  const fetchActive = fetch?.enabled !== false;
  const missing: string[] = [];
  if (!searchActive && !fetchActive) missing.push('webTools.search.enabled');
  if (searchActive && !configured(search?.apiKey, search?.apiKeyRef)) {
    missing.push('webTools.search.apiKeyRef');
  }
  if (
    searchActive &&
    search?.global &&
    !configured(search.global.apiKey, search.global.apiKeyRef)
  ) {
    missing.push('webTools.search.global.apiKeyRef');
  }
  return draft(config.webTools?.enabled === true, missing);
}

function evaluateImageGen({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const tools = config.imageGenTools;
  const engines = [
    ['gptImage2', tools?.gptImage2],
    ['seedream', tools?.seedream],
  ] as const;
  const active = engines.filter(([, engine]) => engine && engine.enabled !== false);
  const missing: string[] = [];
  if (active.length === 0) missing.push('imageGenTools.gptImage2.enabled');
  for (const [key, engine] of active) {
    if (!configured(engine?.apiKey, engine?.apiKeyRef))
      missing.push(`imageGenTools.${key}.apiKeyRef`);
    // seedream 有内置 base URL 与模型默认值；gptImage2 必须显式指向自建网关。
    if (key === 'gptImage2' && !configured(engine?.baseUrl)) {
      missing.push('imageGenTools.gptImage2.baseUrl');
    }
  }
  return draft(tools?.enabled === true, missing);
}

function evaluateStt({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const stt = config.stt;
  const missing: string[] = [];
  // Bucket / Endpoint 有运行时默认值，只有三项凭据是启用前必须齐备的。
  if (!configured(stt?.apiKey, stt?.apiKeyRef)) missing.push('stt.apiKeyRef');
  if (!configured(stt?.ossAccessKeyId, stt?.ossAccessKeyIdRef))
    missing.push('stt.ossAccessKeyIdRef');
  if (!configured(stt?.ossAccessKeySecret, stt?.ossAccessKeySecretRef)) {
    missing.push('stt.ossAccessKeySecretRef');
  }
  return draft(stt?.enabled === true, missing);
}

function evaluateTts({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const tts = config.tts;
  const missing: string[] = [];
  if (!configured(tts?.doubaoAppId)) missing.push('tts.doubaoAppId');
  if (!configured(tts?.doubaoApiKey)) missing.push('tts.doubaoApiKey');
  return draft(isTtsCapabilityEnabled(tts), missing);
}

function evaluateMemory({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const index = config.memory?.index;
  const missing: string[] = [];
  const blockers: CapabilityBlocker[] = [];
  if (index && index.enabled !== false) {
    if (!configured(index.embedding.apiKey, index.embedding.apiKeyRef)) {
      missing.push('memory.index.embedding.apiKeyRef');
    }
    const { tokens, overlap } = index.chunking ?? {};
    if (tokens !== undefined && overlap !== undefined && overlap >= tokens) {
      blockers.push(parameterBlocker('memory.index.chunking.overlap 必须小于 chunking.tokens'));
    }
    if (index.search?.vectorWeight === 0 && index.search?.textWeight === 0) {
      blockers.push(parameterBlocker('向量权重与文本权重不能同时为 0，否则检索恒无结果'));
    }
  }
  return draft(config.memory?.enabled === true, missing, blockers);
}

function evaluateMemoryPolling({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const polling = config.memory?.polling;
  const missing: string[] = [];
  const blockers: CapabilityBlocker[] = [];
  if (config.memory?.enabled !== true) {
    blockers.push(dependencyBlocker('记忆轮询要求先启用 Memory 总能力', 'memory'));
  }
  const hour = polling?.hour ?? 4;
  const hoursSpan = polling?.hoursSpan ?? 4;
  if (hour + hoursSpan > 24) {
    blockers.push(parameterBlocker('调度窗口不得跨越次日：hour + hoursSpan 必须不超过 24'));
  }
  if (polling?.model && !findConfiguredModel(config.models, polling.model)) {
    missing.push('memory.polling.model');
  }
  return draft(polling?.enabled === true, missing, blockers);
}

function evaluateMemoryConsolidation({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const consolidation = config.memory?.consolidation;
  const blockers: CapabilityBlocker[] = [];
  if (config.memory?.enabled !== true) {
    blockers.push(dependencyBlocker('记忆整合要求先启用 Memory 总能力', 'memory'));
  }
  if (!isPostgresEventStore(config)) {
    blockers.push(eventStoreBlocker('记忆整合要求 runtimeEventStore.backend="pg"'));
  }
  const lease = consolidation?.leaseSeconds ?? MEMORY_CONSOLIDATION_DEFAULTS.leaseSeconds;
  const timeout = consolidation?.timeoutSeconds ?? MEMORY_CONSOLIDATION_DEFAULTS.timeoutSeconds;
  if (lease <= timeout) {
    blockers.push(
      parameterBlocker('leaseSeconds 必须大于 timeoutSeconds，否则任务在完成前必然过期'),
    );
  }
  return draft(consolidation?.enabled === true, [], blockers);
}

function evaluateCron({ config }: CapabilityEvaluationContext): CapabilityDraft {
  // cron.store 属于部署配置且有运行时默认值，不由管理员在浏览器里填写（方案 §5.10）。
  return draft(config.cron?.enabled === true);
}

function evaluateSystemMonitor({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const monitor = config.systemMonitor;
  const missing: string[] = [];
  const hosts = monitor?.tlsCheckHosts ?? [];
  if (hosts.some((host) => !HOSTNAME.test(host.trim())))
    missing.push('systemMonitor.tlsCheckHosts');
  return draft(monitor?.enabled === true, missing);
}

function evaluateEventRetention({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const retention = config.runtimeEventRetention;
  const missing: string[] = [];
  const blockers: CapabilityBlocker[] = [];
  if (!isPostgresEventStore(config)) {
    blockers.push(eventStoreBlocker('事件保留要求 runtimeEventStore.backend="pg"'));
  }
  if (retention?.executionMode === 'execute') {
    if (!configured(retention.authorizationRef)) {
      missing.push('runtimeEventRetention.authorizationRef');
    }
    const watermark = retention.legalDeleteThroughGlobalSequence;
    if (!watermark || !/^\d+$/u.test(watermark) || BigInt(watermark) <= 0n) {
      missing.push('runtimeEventRetention.legalDeleteThroughGlobalSequence');
    }
  }
  return draft(retention?.enabled === true, missing, blockers);
}

interface ToolDependencyRule {
  tool: string;
  capability: CapabilityId;
  exposed: (config: AppConfig) => boolean;
}

const TOOL_DEPENDENCY_RULES: readonly ToolDependencyRule[] = [
  {
    tool: 'WebSearch',
    capability: 'webTools',
    exposed: (config) =>
      Boolean(config.webTools?.search) && config.webTools?.search?.enabled !== false,
  },
  {
    tool: 'WebFetch',
    capability: 'webTools',
    exposed: (config) => config.webTools?.fetch?.enabled !== false,
  },
  { tool: 'GenerateImage', capability: 'imageGen', exposed: () => true },
  { tool: 'AudioTranscribe', capability: 'stt', exposed: () => true },
];

const DEPENDENCY_STATE_TEXT: Readonly<Record<string, string>> = {
  disabled: '未启用',
  incomplete: '缺少配置',
  ready: '验证通过但未启用',
  degraded: '运行异常',
  blocked: '受阻塞',
};

function evaluateToolControls({
  config,
  dependencies,
}: CapabilityEvaluationContext): CapabilityDraft {
  const controls = config.toolControls;
  const blockers: CapabilityBlocker[] = [];
  for (const rule of TOOL_DEPENDENCY_RULES) {
    if (!isToolEnabled(controls, rule.tool) || !rule.exposed(config)) continue;
    const dependency = dependencies.get(rule.capability);
    if (!dependency) continue;
    // 依赖的最终 state 才算数：探测失败的能力是 degraded，不能因为开关还开着就放行。
    if (dependency.state === 'enabled' || dependency.state === 'validating') continue;
    // 依赖能力当前是活的但不健康时一律阻塞；整体没开、工具又只是「默认可见」的
    // 情况不算阻塞，只有显式点亮工具才追究。
    const dependencyIsLive = dependency.state === 'degraded' || dependency.state === 'blocked';
    if (!dependencyIsLive && controls?.tools?.[rule.tool]?.enabled !== true) continue;
    blockers.push(
      dependencyBlocker(
        `${rule.tool} 依赖的能力当前${DEPENDENCY_STATE_TEXT[dependency.state] ?? '不可用'}，暴露给模型会在调用时失败`,
        rule.capability,
      ),
    );
  }
  // 与既有 capabilities 兼容字段同义：没有 toolControls 段 = 沿用平台默认，不算显式启用。
  const explicit = Boolean(controls) && typeof controls === 'object';
  return draft(explicit && controls?.enabled !== false, [], blockers);
}

function evaluateAcs({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const hands = config.tenantRemoteHands?.hands ?? [];
  const missing: string[] = [];
  const blockers: CapabilityBlocker[] = [];
  hands.forEach((hand, index) => {
    if (!configured(hand.authToken, hand.authTokenRef)) {
      missing.push(`tenantRemoteHands.hands[${index}].authTokenRef`);
    }
  });
  if (hands.length > 0 && !isPostgresEventStore(config)) {
    blockers.push(eventStoreBlocker('ACS 执行环境要求 runtimeEventStore.backend="pg"'));
  }
  return draft(hands.length > 0, missing, blockers);
}

export const CAPABILITY_EVALUATORS: Readonly<Record<CapabilityId, CapabilityEvaluator>> = {
  models: evaluateModels,
  codex: evaluateCodex,
  webTools: evaluateWebTools,
  imageGen: evaluateImageGen,
  stt: evaluateStt,
  tts: evaluateTts,
  memory: evaluateMemory,
  memoryPolling: evaluateMemoryPolling,
  memoryConsolidation: evaluateMemoryConsolidation,
  cron: evaluateCron,
  systemMonitor: evaluateSystemMonitor,
  eventRetention: evaluateEventRetention,
  toolControls: evaluateToolControls,
  acs: evaluateAcs,
};

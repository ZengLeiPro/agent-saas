import { createHash } from 'node:crypto';
import type { EffortCapability, ModelProviderOptions } from '../../types/index.js';

export type SubagentModelPolicy =
  | { strategy: 'inherit' }
  | { strategy: 'default'; modelRef: string }
  | { strategy: 'fixed'; modelRef: string };

export interface SubagentResolvedModel {
  model: string;
  connection?: { apiKey?: string; baseUrl?: string };
  providerOptions?: ModelProviderOptions;
}

export type SubagentModelResolver = (
  modelRef: string,
  tenantId?: string,
) => SubagentResolvedModel | null | undefined;

export type SubagentModelSource =
  'explicit' | 'execution_context' | 'profile' | 'worker' | 'inherited_ref' | 'parent_run' | 'none';

export type SubagentEffortSource =
  'explicit' | 'inherited' | 'configured' | 'capability_default' | 'none';

export interface SubagentExecutionOptionsInput {
  /** 字段存在性在调用方保留；undefined 表示未显式请求。 */
  requestedModelRef?: string;
  requestedEffort?: string;
  inheritedModelRef?: string;
  inheritedModel?: string;
  inheritedEffort?: string;
  parentRunModel?: string;
  tenantId?: string;
  modelResolver?: SubagentModelResolver;
  profileModel?: SubagentModelPolicy;
  workerModel?: SubagentModelPolicy;
  /** WorkOrder 固化的模型上下文，视作比 Profile/Worker 更高的锁定约束。 */
  executionContextModelRef?: string;
}

export interface SubagentExecutionOptions {
  requestedModelRef?: string;
  resolvedModelRef?: string;
  model: string;
  connection?: { apiKey?: string; baseUrl?: string };
  providerOptions?: ModelProviderOptions;
  modelSource: SubagentModelSource;
  modelLocked: boolean;
  requestedEffort?: string;
  resolvedEffort?: string;
  effortSource: SubagentEffortSource;
  effortCapability?: EffortCapability;
}

export class SubagentExecutionOptionsError extends Error {
  readonly code:
    | 'MODEL_POLICY_CONFLICT'
    | 'MODEL_UNAVAILABLE'
    | 'MODEL_MISSING'
    | 'EFFORT_UNSUPPORTED'
    | 'EFFORT_INVALID';

  constructor(code: SubagentExecutionOptionsError['code'], message: string) {
    super(message);
    this.name = 'SubagentExecutionOptionsError';
    this.code = code;
  }
}

/** 首次委派的逻辑身份由父提交幂等键确定，重复投递不会凭空生成第二个 Agent。 */
export function deriveSubagentAgentId(input: {
  parentSessionId: string;
  parentRunId: string;
  toolCallId: string;
}): string {
  const digest = createHash('sha256')
    .update(`subagent-agent:${input.parentSessionId}:${input.parentRunId}:${input.toolCallId}`)
    .digest('hex');
  return `agent-${digest.slice(0, 32)}`;
}

/**
 * Foreground、background、首次执行和续接共用的模型/effort 解析器。
 *
 * 这个模块只负责确定性策略，不读取全局可变配置，也不修改传入的
 * providerOptions。调用方应在每个 run 重新调用并把返回的副本绑定到该 run。
 */
export function resolveSubagentExecutionOptions(
  input: SubagentExecutionOptionsInput,
): SubagentExecutionOptions {
  const requestedModelRef = normalizeOptional(input.requestedModelRef);
  const requestedEffort = normalizeOptional(input.requestedEffort);
  const lockedCandidates: Array<{
    source: Exclude<SubagentModelSource, 'explicit' | 'none'>;
    ref: string;
  }> = [];
  const defaultCandidates: Array<{
    source: Exclude<SubagentModelSource, 'explicit' | 'none'>;
    ref: string;
  }> = [];

  const addLock = (
    source: Exclude<SubagentModelSource, 'explicit' | 'none'>,
    ref: string | undefined,
  ): void => {
    const normalized = normalizeOptional(ref);
    if (normalized) lockedCandidates.push({ source, ref: normalized });
  };
  addLock('execution_context', input.executionContextModelRef);
  if (input.profileModel?.strategy === 'fixed') addLock('profile', input.profileModel.modelRef);
  if (input.workerModel?.strategy === 'fixed') addLock('worker', input.workerModel.modelRef);
  if (input.profileModel?.strategy === 'default') {
    const ref = normalizeOptional(input.profileModel.modelRef);
    if (ref) defaultCandidates.push({ source: 'profile', ref });
  }
  if (input.workerModel?.strategy === 'default') {
    const ref = normalizeOptional(input.workerModel.modelRef);
    if (ref) defaultCandidates.push({ source: 'worker', ref });
  }

  const uniqueLocks = [...new Set(lockedCandidates.map((candidate) => candidate.ref))];
  if (uniqueLocks.length > 1) {
    throw new SubagentExecutionOptionsError(
      'MODEL_POLICY_CONFLICT',
      `子 agent 模型锁定策略冲突：${uniqueLocks.join(' 与 ')}`,
    );
  }
  const lockedRef = uniqueLocks[0];
  if (lockedRef && requestedModelRef && lockedRef !== requestedModelRef) {
    throw new SubagentExecutionOptionsError(
      'MODEL_POLICY_CONFLICT',
      `显式 model ${requestedModelRef} 与锁定模型 ${lockedRef} 冲突，不会静默覆盖。`,
    );
  }

  const defaultRef = defaultCandidates.at(-1)?.ref;
  const selectedRef =
    requestedModelRef ?? lockedRef ?? defaultRef ?? normalizeOptional(input.inheritedModelRef);
  const modelSource: SubagentModelSource = requestedModelRef
    ? 'explicit'
    : lockedRef
      ? (lockedCandidates.find((candidate) => candidate.ref === lockedRef)?.source ?? 'profile')
      : defaultRef
        ? (defaultCandidates.at(-1)?.source ?? 'profile')
        : normalizeOptional(input.inheritedModelRef)
          ? 'inherited_ref'
          : normalizeOptional(input.parentRunModel)
            ? 'parent_run'
            : 'none';

  let model = selectedRef
    ? undefined
    : (normalizeOptional(input.inheritedModel) ?? normalizeOptional(input.parentRunModel));
  let connection: { apiKey?: string; baseUrl?: string } | undefined;
  let providerOptions: ModelProviderOptions | undefined;
  if (selectedRef && input.modelResolver) {
    const resolved = input.modelResolver(selectedRef, input.tenantId);
    if (!resolved) {
      throw new SubagentExecutionOptionsError(
        'MODEL_UNAVAILABLE',
        `子 agent 模型 "${selectedRef}" 不在当前组织可用模型白名单内。`,
      );
    }
    model = resolved.model;
    connection = resolved.connection;
    providerOptions = cloneProviderOptions(resolved.providerOptions);
  }
  if (!model && selectedRef) model = selectedRef;
  if (!model) {
    throw new SubagentExecutionOptionsError(
      'MODEL_MISSING',
      '无法确定子 agent 模型：父会话没有可继承的模型，且未提供 model。',
    );
  }

  const effortCapability = providerOptions?.reasoningEffortCapability;
  const configuredEffort = normalizeOptional(providerOptions?.reasoningEffort);
  const inheritedRef = normalizeOptional(input.inheritedModelRef);
  // 模型变化时不把上一模型的 effort 搬过去；改用目标模型自己的配置或能力默认值。
  const inheritedEffort =
    !selectedRef || selectedRef === inheritedRef
      ? normalizeOptional(input.inheritedEffort)
      : undefined;
  let resolvedEffort = requestedEffort ?? inheritedEffort ?? configuredEffort;
  let effortSource: SubagentEffortSource = requestedEffort
    ? 'explicit'
    : inheritedEffort
      ? 'inherited'
      : configuredEffort
        ? 'configured'
        : 'none';
  if (!resolvedEffort && effortCapability?.defaultValue) {
    resolvedEffort = effortCapability.defaultValue;
    effortSource = 'capability_default';
  }

  if (requestedEffort) {
    if (effortCapability?.support !== 'supported' || !effortCapability.values?.length) {
      throw new SubagentExecutionOptionsError(
        'EFFORT_UNSUPPORTED',
        `模型 ${selectedRef ?? model} 没有已验证的 reasoning effort 值目录，拒绝显式 effort=${requestedEffort}。`,
      );
    }
  }
  if (
    resolvedEffort &&
    effortCapability?.values?.length &&
    !effortCapability.values.includes(resolvedEffort)
  ) {
    throw new SubagentExecutionOptionsError(
      'EFFORT_INVALID',
      `模型 ${selectedRef ?? model} 不接受 reasoning effort=${resolvedEffort}，可用值：${effortCapability.values.join(', ')}。`,
    );
  }

  if (resolvedEffort) {
    providerOptions = {
      ...(providerOptions ?? {}),
      reasoningEffort: resolvedEffort,
    };
  }

  return {
    ...(requestedModelRef ? { requestedModelRef } : {}),
    ...(selectedRef ? { resolvedModelRef: selectedRef } : {}),
    model,
    ...(connection ? { connection } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    modelSource,
    modelLocked: Boolean(lockedRef),
    ...(requestedEffort ? { requestedEffort } : {}),
    ...(resolvedEffort ? { resolvedEffort } : {}),
    effortSource,
    ...(effortCapability ? { effortCapability: cloneEffortCapability(effortCapability) } : {}),
  };
}

export function cloneProviderOptions(
  providerOptions: ModelProviderOptions | undefined,
): ModelProviderOptions | undefined {
  if (!providerOptions) return undefined;
  return {
    ...providerOptions,
    ...(providerOptions.extraBody ? { extraBody: { ...providerOptions.extraBody } } : {}),
    ...(providerOptions.inputModalities
      ? { inputModalities: [...providerOptions.inputModalities] }
      : {}),
    ...(providerOptions.preStreamRetryDelaysMs
      ? { preStreamRetryDelaysMs: [...providerOptions.preStreamRetryDelaysMs] }
      : {}),
    ...(providerOptions.toolChoiceModes
      ? { toolChoiceModes: [...providerOptions.toolChoiceModes] }
      : {}),
    ...(providerOptions.reasoningEffortCapability
      ? {
          reasoningEffortCapability: cloneEffortCapability(
            providerOptions.reasoningEffortCapability,
          ),
        }
      : {}),
  };
}

function cloneEffortCapability(capability: EffortCapability): EffortCapability {
  return {
    ...capability,
    ...(capability.values ? { values: [...capability.values] } : {}),
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

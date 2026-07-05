/**
 * Model Resolver
 *
 * 解析模型引用（"groupId/modelId"）为具体的 SDK 参数，
 * 以及生成脱敏的公开模型列表供 API 返回。
 */

import type { ModelProviderOptions, ModelsConfig } from '../types/index.js';
import type { AgentRunOptions } from '../agent/types.js';
import type { TenantSettings } from '../data/tenants/types.js';

export interface ResolvedModel {
  model: string;
  connection?: { apiKey?: string; baseUrl?: string };
  providerOptions?: ModelProviderOptions;
}

export interface PublicModelGroup {
  id: string;
  name: string;
  models: { id: string; name: string; description?: string; recommended?: boolean }[];
}

export interface PublicModelList {
  groups: PublicModelGroup[];
  default: string;
  allowCrossGroupSwitch: boolean;
  showGroupNames: boolean;
  /** 是否向当前组织成员显示顶部上下文/Token 统计（租户策略，缺省 true）。 */
  showContextTokens: boolean;
}

export interface ModelContextAccounting {
  exact: boolean;
  kind: 'exact_current' | 'stateful_response_exact' | 'unknown';
  source: 'provider_usage' | 'unknown';
  label: string;
  reason?: string;
}

export function resolveContextAccountingFromModels(
  modelsConfig: ModelsConfig | undefined,
  modelRef: string | undefined,
): ModelContextAccounting {
  if (!modelsConfig || !modelRef) {
    return {
      exact: false,
      kind: 'unknown',
      source: 'unknown',
      label: '上下文不可确认',
      reason: '当前会话缺少可解析的模型配置，不能把 transcript 最后一轮 usage 当作准确当前上下文。',
    };
  }

  const slashIdx = modelRef.indexOf('/');
  if (slashIdx < 0) {
    return {
      exact: false,
      kind: 'unknown',
      source: 'unknown',
      label: '上下文不可确认',
      reason: `模型引用 ${modelRef} 不是 group/model 格式，无法确认上下文口径。`,
    };
  }

  const groupId = modelRef.slice(0, slashIdx);
  const modelId = modelRef.slice(slashIdx + 1);
  const group = modelsConfig.groups.find((item) => item.id === groupId);
  const model = group?.models.find((item) => item.id === modelId);
  if (!group || !model) {
    return {
      exact: false,
      kind: 'unknown',
      source: 'unknown',
      label: '上下文不可确认',
      reason: `模型引用 ${modelRef} 已不在当前模型配置中，无法确认上下文口径。`,
    };
  }

  const protocol = model.protocol ?? group.protocol;
  const disableResponseChaining = model.disable_response_chaining ?? group.disable_response_chaining ?? false;
  if (protocol === 'responses' && !disableResponseChaining) {
    // previous_response_id 接力 + prompt cache 下，上游每 leg usage.input_tokens
    // 只报告本 leg 的 payload（含 cache_read_input_tokens），不是「chain 内累计
    // 历史」——2026-07-05 glm-5.2 实测：6 leg 序列 10421→6816→6929→7029→7132→7243
    // 明显非全量递增，反而 leg 2 已经小于首 leg（一次性 inject 未进 chain）。
    // 老口径「最后一 leg input+output」会低估约 chain 累计历史量级。
    // 现在改为逐 leg 累加 (input - cache_read) + output（parse.ts:getTokenUsage
    // 实现），并在 cache_read=0 时锚定到 input+output 以覆盖 /compact 清链、
    // cache 过期、跨模型接力等重锚场景。
    return {
      exact: true,
      kind: 'stateful_response_exact',
      source: 'provider_usage',
      label: '当前上下文',
      reason: '该模型启用 previous_response_id 接力，按 (input−cache_read)+output 逐 leg 累加估算 chain 累计上下文；cache miss（含首 leg、/compact 后清链、跨模型接力）时自动重锚。',
    };
  }

  return {
    exact: true,
    kind: 'exact_current',
    source: 'provider_usage',
    label: '当前上下文',
    reason: protocol === 'responses'
      ? '该 Responses 模型关闭了 previous_response_id，每轮全量发送历史；provider usage 可作为准确当前上下文。'
      : '该模型每轮全量发送历史；provider usage 可作为准确当前上下文。',
  };
}

/**
 * 返回脱敏模型列表（不含 apiKey/baseUrl/env），供前端展示
 */
export function getPublicModelList(modelsConfig: ModelsConfig): PublicModelList {
  return {
    groups: modelsConfig.groups.map((g) => ({
      id: g.id,
      name: g.name,
      models: g.models.map((m) => ({ id: m.id, name: m.name })),
    })),
    default: modelsConfig.default,
    allowCrossGroupSwitch: modelsConfig.allowCrossGroupSwitch,
    showGroupNames: true,
    showContextTokens: true,
  };
}

export function getTenantPublicModelList(
  modelsConfig: ModelsConfig,
  tenantSettings: TenantSettings | undefined,
): PublicModelList {
  if (!tenantSettings) return getPublicModelList(modelsConfig);

  const allowed = tenantSettings.models.allowedModels;
  const hasWhitelist = allowed.length > 0;
  const allowedSet = new Set(allowed);
  const overrides = tenantSettings.models.displayOverrides ?? {};
  const lockedDefaultRef = tenantSettings.models.allowUserModelSwitch
    ? undefined
    : tenantSettings.models.defaultModel || modelsConfig.default;

  const groups = modelsConfig.groups
    .map((g) => {
      const groupModels = g.models
        .map((m) => {
          const ref = `${g.id}/${m.id}`;
          if (hasWhitelist && !allowedSet.has(ref)) return null;
          if (lockedDefaultRef && ref !== lockedDefaultRef) return null;
          const override = overrides[ref];
          if (override?.displayName === "") return null;
          return {
            id: m.id,
            name: override?.displayName || m.name,
            ...(override?.description ? { description: override.description } : {}),
            ...(override?.recommended !== undefined ? { recommended: override.recommended } : {}),
            sortOrder: override?.sortOrder,
          };
        })
        .filter((m): m is NonNullable<typeof m> => Boolean(m))
        .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
      const groupDisplayName = g.models
        .map((m) => overrides[`${g.id}/${m.id}`]?.groupDisplayName)
        .find((value): value is string => Boolean(value));
      return {
        id: g.id,
        name: groupDisplayName || g.name,
        models: groupModels.map(({ sortOrder: _sortOrder, ...model }) => model),
      };
    })
    .filter((g) => g.models.length > 0);

  const visibleRefs = new Set(groups.flatMap((g) => g.models.map((m) => `${g.id}/${m.id}`)));
  const requestedDefault = tenantSettings.models.defaultModel || modelsConfig.default;
  const defaultRef = visibleRefs.has(requestedDefault)
    ? requestedDefault
    : groups[0]?.models[0]
      ? `${groups[0].id}/${groups[0].models[0].id}`
      : modelsConfig.default;

  return {
    groups,
    default: defaultRef,
    allowCrossGroupSwitch: modelsConfig.allowCrossGroupSwitch && tenantSettings.models.allowUserModelSwitch,
    showGroupNames: tenantSettings.models.showGroupNames,
    showContextTokens: tenantSettings.models.showContextTokens !== false,
  };
}

export function isModelAllowedForTenant(
  modelsConfig: ModelsConfig,
  tenantSettings: TenantSettings | undefined,
  ref: string,
): boolean {
  const slashIdx = ref.indexOf('/');
  if (slashIdx < 0) return false;
  const groupId = ref.slice(0, slashIdx);
  const modelId = ref.slice(slashIdx + 1);
  const exists = modelsConfig.groups.some((g) => g.id === groupId && g.models.some((m) => m.id === modelId));
  if (!exists) return false;
  if (!tenantSettings) return true;
  const allowed = tenantSettings.models.allowedModels;
  if (allowed.length > 0 && !allowed.includes(ref)) return false;
  if (!tenantSettings.models.allowUserModelSwitch) {
    const tenantList = getTenantPublicModelList(modelsConfig, tenantSettings);
    return ref === tenantList.default;
  }
  return true;
}

/**
 * 解析 "groupId/modelId" 为 SDK 运行参数
 *
 * 将 group 级的 apiKey、baseUrl、env 合并为统一的 env 字典，
 * 供 runner 直接 merge 到 agentOptions.env 中。
 *
 * 当 ref 失效（模型被删/改名，如 opus 4.7→4.8）时，回退到配置的
 * default 模型，而不是返回 null 让调用方静默走 SDK env 默认模型。
 * 仅当 default 本身也无效（配置损坏）时才返回 null。
 *
 * @returns ResolvedModel 或 null（引用与 default 均无效时）
 */
export function resolveModelRef(
  modelsConfig: ModelsConfig,
  ref: string,
): ResolvedModel | null {
  const resolved = resolveModelRefStrict(modelsConfig, ref);
  if (resolved) return resolved;
  if (ref !== modelsConfig.default) {
    return resolveModelRefStrict(modelsConfig, modelsConfig.default);
  }
  return null;
}

/**
 * 严格解析：ref 无效时返回 null，不做任何回退。
 */
function resolveModelRefStrict(
  modelsConfig: ModelsConfig,
  ref: string,
): ResolvedModel | null {
  const slashIdx = ref.indexOf('/');
  if (slashIdx < 0) return null;

  const groupId = ref.slice(0, slashIdx);
  const modelId = ref.slice(slashIdx + 1);

  const group = modelsConfig.groups.find((g) => g.id === groupId);
  if (!group) return null;

  const model = group.models.find((m) => m.id === modelId);
  if (!model) return null;

  return {
    model: model.value,
    connection: {
      ...(group.apiKey !== undefined ? { apiKey: group.apiKey } : {}),
      ...(group.baseUrl != null ? { baseUrl: group.baseUrl } : {}),
    },
    ...withProviderOptions(resolveProviderOptions(group, model)),
  };
}

/**
 * 把 ResolvedModel 映射为 channel 构建 AgentRunOptions 时需要 spread 的子集。
 * 当前主路径是 raw runtime，模型组解析为 provider-neutral 连接信息。
 */
export function toRunModelOptions(
  resolved: ResolvedModel,
): Pick<AgentRunOptions, 'model' | 'modelConnection' | 'modelProviderOptions'> {
  return {
    model: resolved.model,
    ...(resolved.connection ? { modelConnection: resolved.connection } : {}),
    ...(resolved.providerOptions ? { modelProviderOptions: resolved.providerOptions } : {}),
  };
}

type ConfigProviderOptions = {
  thinking?: unknown;
  reasoning_effort?: string;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  // ── Responses API v1（RFC P0.5）配置层字段（snake_case 与 config.json 对齐） ──
  protocol?: 'chat_completions' | 'responses';
  alias_actual?: string;
  supports_reasoning_output?: boolean;
  supports_tool_reasoning?: boolean;
  tool_choice_modes?: Array<'auto' | 'required' | 'none' | 'specific'>;
  call_id_format?: string;
  is_pseudo_reasoning?: boolean;
  disable_response_chaining?: boolean;
  disable_prompt_cache_key?: boolean;
};

function resolveProviderOptions(
  group: ConfigProviderOptions,
  model: ConfigProviderOptions,
): ModelProviderOptions | undefined {
  const extraBody = {
    ...(group.extraBody ?? {}),
    ...(model.extraBody ?? {}),
  };
  const reasoningEffort = model.reasoning_effort
    ?? model.reasoningEffort
    ?? group.reasoning_effort
    ?? group.reasoningEffort;
  const thinking = model.thinking !== undefined ? model.thinking : group.thinking;
  // Responses 字段：model 级覆盖 group 级
  const protocol = model.protocol ?? group.protocol;
  const aliasActual = model.alias_actual ?? group.alias_actual;
  const supportsReasoningOutput = model.supports_reasoning_output ?? group.supports_reasoning_output;
  const supportsToolReasoning = model.supports_tool_reasoning ?? group.supports_tool_reasoning;
  const toolChoiceModes = model.tool_choice_modes ?? group.tool_choice_modes;
  const callIdFormat = model.call_id_format ?? group.call_id_format;
  const isPseudoReasoning = model.is_pseudo_reasoning ?? group.is_pseudo_reasoning;
  const disableResponseChaining = model.disable_response_chaining ?? group.disable_response_chaining;
  const disablePromptCacheKey = model.disable_prompt_cache_key ?? group.disable_prompt_cache_key;
  const options: ModelProviderOptions = {};
  if (Object.keys(extraBody).length > 0) options.extraBody = extraBody;
  if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
  if (thinking !== undefined) options.thinking = thinking;
  if (protocol !== undefined) options.protocol = protocol;
  if (aliasActual !== undefined) options.aliasActual = aliasActual;
  if (supportsReasoningOutput !== undefined) options.supportsReasoningOutput = supportsReasoningOutput;
  if (supportsToolReasoning !== undefined) options.supportsToolReasoning = supportsToolReasoning;
  if (toolChoiceModes !== undefined) options.toolChoiceModes = toolChoiceModes;
  if (callIdFormat !== undefined) options.callIdFormat = callIdFormat;
  if (isPseudoReasoning !== undefined) options.isPseudoReasoning = isPseudoReasoning;
  if (disableResponseChaining !== undefined) options.disableResponseChaining = disableResponseChaining;
  if (disablePromptCacheKey !== undefined) options.disablePromptCacheKey = disablePromptCacheKey;
  return Object.keys(options).length > 0 ? options : undefined;
}

function withProviderOptions(
  providerOptions: ModelProviderOptions | undefined,
): { providerOptions?: ModelProviderOptions } {
  return providerOptions ? { providerOptions } : {};
}

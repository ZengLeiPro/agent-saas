import { z } from 'zod';
interface SubscriptionModel {
  id: string;
  protocol?: string;
  responses_transport?: string; mcp_loading_mode?: string; tool_search_protocol?: string;
}
interface SubscriptionGroup {
  id: string;
  protocol?: string;
  responses_transport?: string; mcp_loading_mode?: string; tool_search_protocol?: string;
  models: SubscriptionModel[];
}
interface SubscriptionConfiguration {
  models?: {
    groups: SubscriptionGroup[];
    imageUnderstanding?: { model: string; fallbackModels?: string[] };
  };
  guardrail?: { model?: string; fallbackModels?: string[] };
  codexSubscription?: unknown;
  grokSubscription?: unknown;
}
/** Shared configuration gate; standalone API-key auxiliaries are never silently substituted. */
export function validateSubscriptionModels(
  value: SubscriptionConfiguration,
  ctx: z.RefinementCtx,
): void {
  for (const [groupIndex, group] of (value.models?.groups ?? []).entries()) {
    for (const [modelIndex, model] of group.models.entries()) {
      const transport = model.responses_transport ?? group.responses_transport;
      if (transport !== 'codex_subscription' && transport !== 'grok_subscription') continue;
      const root = transport === 'grok_subscription' ? 'grokSubscription' : 'codexSubscription';
      if ((model.protocol ?? group.protocol ?? 'chat_completions') !== 'responses')
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', 'groups', groupIndex, 'models', modelIndex, 'responses_transport'],
          message: `${transport} 只能用于 protocol="responses"`,
        });
      if (transport === 'grok_subscription' && ((model.mcp_loading_mode ?? group.mcp_loading_mode) === 'deferred'
          || (model.tool_search_protocol ?? group.tool_search_protocol) === 'openai_responses_hosted')) ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['models', 'groups', groupIndex, 'models', modelIndex, 'mcp_loading_mode'],
        message: 'Grok 订阅尚未验证 hosted tool_search；请使用 eager/auto 与 tool_search_protocol=none，由平台执行完整函数列表。',
      });
      if (!value[root])
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [root],
          message: `存在 ${transport} 模型时必须配置 ${root}`,
        });
    }
  }
  const auxiliaries = [
    { path: ['guardrail'], config: value.guardrail, label: '内容安全门禁' },
    {
      path: ['models', 'imageUnderstanding'],
      config: value.models?.imageUnderstanding,
      label: '独立图片理解',
    },
  ];
  for (const { path, config, label } of auxiliaries) {
    for (const [index, ref] of [config?.model, ...(config?.fallbackModels ?? [])].entries()) {
      if (!ref) continue;
      const slash = ref.indexOf('/');
      const group = value.models?.groups.find((entry) => entry.id === ref.slice(0, slash));
      const model = group?.models.find((entry) => entry.id === ref.slice(slash + 1));
      if (
        model &&
        (model.responses_transport ?? group?.responses_transport) === 'grok_subscription'
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, ...(index === 0 ? ['model'] : ['fallbackModels', index - 1])],
          message: `Grok 订阅尚未支持${label}辅助路径；不会切换到 API Key 计费。`,
        });
    }
  }
}

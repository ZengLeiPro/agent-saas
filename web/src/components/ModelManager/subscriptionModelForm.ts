import type { EditableGroup, EditableModel, ResponsesTransport } from './modelConfigTypes';
export function isSubscriptionTransport(
  value: unknown,
): value is 'codex_subscription' | 'grok_subscription' {
  return value === 'codex_subscription' || value === 'grok_subscription';
}
export function changeGroupTransport(
  group: EditableGroup,
  transport: ResponsesTransport,
): EditableGroup {
  if (!isSubscriptionTransport(transport)) return { ...group, responses_transport: transport };
  return {
    ...group,
    protocol: 'responses',
    responses_transport: transport,
    disable_response_chaining: true,
    disable_prompt_cache_key: transport === 'grok_subscription' ? true : undefined,
    ...(transport === 'grok_subscription'
      ? ({ mcp_loading_mode: 'eager', tool_search_protocol: 'none' } as const)
      : {}),
    models: group.models.map((model) =>
      model.responses_transport === 'openai_compatible' ? model : { ...model, protocol: undefined },
    ),
  };
}
export function changeModelTransport(
  model: EditableModel,
  transport: ResponsesTransport | 'inherit',
): EditableModel {
  if (transport === 'inherit')
    return { ...model, protocol: undefined, responses_transport: undefined };
  if (!isSubscriptionTransport(transport)) return { ...model, responses_transport: transport };
  return {
    ...model,
    protocol: 'responses',
    responses_transport: transport,
    ...(transport === 'grok_subscription'
      ? ({ mcp_loading_mode: 'eager', tool_search_protocol: 'none' } as const)
      : {}),
  };
}
export function subscriptionTransportNotice(transport: unknown): string {
  if (transport === 'grok_subscription')
    return 'Grok 订阅固定使用完整历史 HTTP/SSE、store:false 和平台工具执行；不发送 previous_response_id 或 prompt_cache_key，不启用 WebSocket 接力。图像与 reasoning effort 按各账号订阅目录能力检查；未验证能力会明确拒绝。';
  if (transport === 'codex_subscription')
    return 'Codex 固定逻辑协议：`store:false`、每轮保留完整历史、禁止标准 HTTP `previous_response_id`、稳定 session cache key、encrypted reasoning replay。启用上方 WebSocket 接力后，只压缩线上发送内容；PostgreSQL 完整历史仍是事实源，异常会自动回退全量 HTTP/SSE。';
  return '订阅模型按各自 transport 使用平台授权池。Codex 的 WebSocket 与缓存策略不适用于 Grok；Grok 使用完整历史 HTTP/SSE。';
}

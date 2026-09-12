import { GrokProtocolError, isRecord } from './grokProtocol.js';
import type { GrokCatalogModel } from './grokModelCatalog.js';
/** Full-history replay retains executed function results; only provider-owned anchors are removed. */
export function normalizeGrokRequest(
  raw: Record<string, unknown>,
  resetBinding: boolean,
  model?: GrokCatalogModel,
): Record<string, unknown> {
  if (typeof raw.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw.model))
    throw new GrokProtocolError('invalid_model_id');
  if (!Array.isArray(raw.input)) throw new GrokProtocolError('full_history_required');
  const body: Record<string, unknown> = { ...raw, store: false, stream: true };
  for (const key of [
    'previous_response_id',
    'prompt_cache_key',
    'originator',
    'thinking',
    'reasoning_effort',
  ])
    delete body[key];
  // The common adapter's Codex verbosity preference is not part of the subscription contract.
  if (isRecord(body.text)) {
    const { verbosity: _verbosity, ...text } = body.text;
    if (Object.keys(text).length) body.text = text;
    else delete body.text;
  }
  if (isRecord(body.reasoning)) {
    if (body.reasoning.effort !== undefined) {
      if (model?.supportsReasoningEffort !== true)
        throw new GrokProtocolError('reasoning_effort_capability_unverified');
      body.reasoning = { effort: body.reasoning.effort };
    } else delete body.reasoning;
  }
  body.include = ['reasoning.encrypted_content'];
  const tools = flattenFunctions(Array.isArray(raw.tools) ? raw.tools : []);
  if (tools.length) body.tools = tools;
  else {
    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }
  const imagesAllowed = model?.inputModalities?.includes('image') === true;
  body.input = raw.input.flatMap((item: unknown) => {
    if (!isRecord(item)) throw new GrokProtocolError('invalid_history_item');
    if (item.type === 'additional_tools') return [];
    if (item.type === 'reasoning') return resetBinding ? [] : [item];
    const { namespace: _namespace, ...normalized } = item;
    if (
      Array.isArray(normalized.content) &&
      normalized.content.some((part) => isRecord(part) && part.type === 'input_image') &&
      !imagesAllowed
    )
      throw new GrokProtocolError('image_capability_unverified');
    if (normalized.type === 'function_call_output' && Array.isArray(normalized.output)) {
      if (normalized.output.some((part) => !isRecord(part) || part.type !== 'input_text'))
        throw new GrokProtocolError('unsupported_tool_result_media');
      normalized.output = normalized.output
        .map((part) => String((part as Record<string, unknown>).text ?? ''))
        .join('');
    }
    return [normalized];
  });
  return body;
}
function flattenFunctions(tools: unknown[]): Array<Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const visit = (tool: unknown) => {
    if (!isRecord(tool)) throw new GrokProtocolError('invalid_function_schema');
    if (tool.type === 'tool_search') return;
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      tool.tools.forEach(visit);
      return;
    }
    if (tool.type !== 'function' || typeof tool.name !== 'string')
      throw new GrokProtocolError('unsupported_server_tool');
    const { defer_loading: _defer, namespace: _namespace, ...flat } = tool;
    const previous = result.get(tool.name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(flat))
      throw new GrokProtocolError('ambiguous_function_name');
    result.set(tool.name, flat);
  };
  tools.forEach(visit);
  return [...result.values()];
}

import type { EditableModelsConfig, EditableModel } from './modelConfigTypes';
export interface GrokCatalogEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoningEffort?: boolean;
  inputModalities?: Array<'text' | 'image'>;
}
export interface GrokCatalogResponse {
  source: 'subscription_catalog';
  models: Array<{ id: string; name?: string; eligibleCredentialRefs: string[] }>;
  accounts: Array<{
    credentialRef: string;
    priority: number;
    status: 'fresh' | 'stale' | 'unknown';
    collectedAt?: string;
    error?: string;
    models: GrokCatalogEntry[];
  }>;
}
/** Only common, observed account capabilities become model metadata. Unknown never means unlimited. */
export function catalogImportEntries(
  catalog: GrokCatalogResponse,
  ids: readonly string[],
): GrokCatalogEntry[] {
  return ids.map((id) => {
    const union = catalog.models.find((model) => model.id === id);
    if (!union || !union.eligibleCredentialRefs.length)
      throw new Error('所选模型尚无已确认的订阅账号资格，请重新采集目录。');
    const entries = union.eligibleCredentialRefs.map((ref) =>
      catalog.accounts
        .find((account) => account.credentialRef === ref && account.status === 'fresh')
        ?.models.find((model) => model.id === id),
    );
    if (entries.some((entry) => !entry)) throw new Error('模型资格信息不完整，请重新采集目录。');
    const observed = entries as GrokCatalogEntry[];
    const windows = observed.map((entry) => entry.contextWindow);
    const contextWindow = windows.every(
      (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    )
      ? Math.min(...(windows as number[]))
      : undefined;
    return {
      id,
      name: union.name,
      ...(contextWindow ? { contextWindow } : {}),
      supportsReasoningEffort: observed.every((entry) => entry.supportsReasoningEffort === true),
      inputModalities: observed.every((entry) => entry.inputModalities?.includes('image'))
        ? ['text', 'image']
        : ['text'],
    };
  });
}
export function importGrokCatalogModels(
  current: EditableModelsConfig,
  target: string,
  entries: GrokCatalogEntry[],
): { models: EditableModelsConfig; imported: number } {
  if (!entries.length || entries.length > 100) throw new Error('每次请选择 1 到 100 个订阅模型。');
  const existing = current.groups.find((group) => group.id === target);
  if (target !== '__new__' && (!existing || existing.responses_transport !== 'grok_subscription'))
    throw new Error('请选择 Grok 订阅分组或明确新建一个分组。');
  if (
    existing &&
    (existing.reasoning_effort || existing.reasoningEffort) &&
    entries.some((entry) => entry.supportsReasoningEffort !== true)
  )
    throw new Error(
      '该分组指定了思考深度，但目录未确认所有所选模型支持；请新建分组或先清除该设定。',
    );
  let groupId = existing?.id ?? 'grok-subscription';
  let suffix = 2;
  if (!existing)
    while (current.groups.some((group) => group.id === groupId))
      groupId = `grok-subscription-${suffix++}`;
  const models = [...(existing?.models ?? [])];
  let imported = 0;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(entry.id))
      throw new Error('订阅目录模型 ID 无效。');
    if (
      models.some(
        (model) =>
          (model.value || model.id) === entry.id &&
          (model.responses_transport ?? existing?.responses_transport) === 'grok_subscription',
      )
    )
      continue;
    const baseId = entry.id.replace(/[^A-Za-z0-9._-]/g, '-');
    let id = baseId;
    let n = 2;
    while (models.some((model) => model.id === id)) id = `${baseId}-${n++}`;
    const model: EditableModel = {
      id,
      name: entry.name || entry.id,
      value: entry.id,
      protocol: 'responses',
      responses_transport: 'grok_subscription',
      mcp_loading_mode: 'eager',
      tool_search_protocol: 'none',
      input_modalities: entry.inputModalities ?? ['text'],
      ...(entry.contextWindow ? { context_window: entry.contextWindow } : {}),
    };
    models.push(model);
    imported += 1;
  }
  if (!imported) return { models: current, imported };
  const group = existing
    ? { ...existing, models }
    : {
        id: groupId,
        name: 'Grok 订阅',
        protocol: 'responses' as const,
        responses_transport: 'grok_subscription' as const,
        mcp_loading_mode: 'eager' as const,
        tool_search_protocol: 'none' as const,
        disable_response_chaining: true,
        disable_prompt_cache_key: true,
        models,
      };
  // Preserve platform default, helper references, existing prices and every unrelated group.
  return {
    models: {
      ...current,
      groups: existing
        ? current.groups.map((item) => (item.id === existing.id ? group : item))
        : [...current.groups, group],
    },
    imported,
  };
}

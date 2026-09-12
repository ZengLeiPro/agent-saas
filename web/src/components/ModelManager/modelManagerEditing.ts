import type {
  ModelProtocol,
  ResponsesTransport,
  EditableGroup,
  EditableModel,
  EditableMemoryIndexConfig,
} from './modelConfigTypes';
export const DEFAULT_PROTOCOL: ModelProtocol = 'chat_completions';
export const INHERIT_PROTOCOL = '__inherit__';
export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export function nextCopyValue(base: string, existingValues: string[]): string {
  const existing = new Set(existingValues);
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

export function nextCopyId(modelId: string, models: EditableModel[]): string {
  const base = `${modelId.trim() || 'model'}-copy`;
  const existing = new Set(models.map((model) => model.id));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export const emptyModel = (): EditableModel => ({ id: '', name: '', value: '' });
export const emptyGroup = (): EditableGroup => ({
  id: '',
  name: '',
  protocol: DEFAULT_PROTOCOL,
  models: [emptyModel()],
});

export const emptyPricing = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

export const defaultMemoryIndex = (): EditableMemoryIndexConfig => ({
  enabled: false,
  dbDir: 'data/memory-index',
  embedding: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    apiKey: '',
    model: 'text-embedding-v3',
    dimensions: 1024,
  },
  chunking: {
    tokens: 200,
    overlap: 40,
  },
  search: {
    vectorWeight: 0.7,
    textWeight: 0.3,
    maxResults: 10,
    minScore: 0.3,
  },
  temporalDecay: {
    enabled: false,
    halfLifeDays: 30,
  },
  sync: {
    debounceMs: 1500,
  },
});

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function parseOptionalJsonObject(
  text: string,
  label: string,
): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseOptionalJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as unknown;
}

export function normalizePricing(pricing: EditableModel['pricing']): EditableModel['pricing'] {
  if (!pricing) return undefined;
  return {
    input: Number(pricing.input) || 0,
    output: Number(pricing.output) || 0,
    cacheCreation: Number(pricing.cacheCreation) || 0,
    cacheRead: Number(pricing.cacheRead) || 0,
  };
}

export function resolveGroupProtocol(group: EditableGroup): ModelProtocol {
  return group.protocol ?? DEFAULT_PROTOCOL;
}

export function resolveModelProtocol(group: EditableGroup, model: EditableModel): ModelProtocol {
  return model.protocol ?? resolveGroupProtocol(group);
}

export function resolveGroupReasoningEffort(group: EditableGroup): string | undefined {
  return group.reasoning_effort ?? group.reasoningEffort;
}

export function resolveModelReasoningEffort(
  group: EditableGroup,
  model: EditableModel,
): string | undefined {
  return model.reasoning_effort ?? model.reasoningEffort ?? resolveGroupReasoningEffort(group);
}

export function resolveModelImageInput(group: EditableGroup, model: EditableModel): boolean {
  return (model.input_modalities ?? group.input_modalities)?.includes('image') === true;
}

export function resolveResponsesTransport(
  group: EditableGroup,
  model?: EditableModel,
): ResponsesTransport {
  return model?.responses_transport ?? group.responses_transport ?? 'openai_compatible';
}

export function formatEffectiveValue(value: string | undefined): string {
  return value || '未指定';
}

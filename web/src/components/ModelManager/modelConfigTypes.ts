import type { ConfigWritePolicy } from '@agent/shared/configWritePolicy';
import type { ModelList } from '@/types/models';
import type { EditableQuotaSource } from './GroupCredentialsFields';
import type { UtilityModelAdminFields } from './UtilityModelSettings';

export type ModelProtocol = 'chat_completions' | 'responses';
export type ResponsesTransport = 'openai_compatible' | 'codex_subscription' | 'grok_subscription';
export type McpLoadingMode = 'auto' | 'eager' | 'deferred';
export type ToolSearchProtocol = 'none' | 'openai_responses_hosted';

export type EditableModel = {
  id: string;
  name: string;
  value: string;
  pricing?: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  thinking?: unknown;
  reasoning_effort?: string;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  input_modalities?: Array<'text' | 'image'>;
  protocol?: ModelProtocol;
  responses_transport?: ResponsesTransport;
  usage_accounting?: 'input_includes_cache' | 'cache_tokens_separate';
  alias_actual?: string;
  context_window?: number;
  auto_compact_threshold?: number;
  tool_choice_modes?: Array<'auto' | 'required' | 'none' | 'specific'>;
  is_pseudo_reasoning?: boolean;
  mcp_loading_mode?: McpLoadingMode;
  tool_search_protocol?: ToolSearchProtocol;
};

export type EditableGroup = {
  id: string;
  name: string;
  /** 本地 draft：GET 不再回显明文，留空/缺失时服务端保留现有 Key */
  apiKey?: string;
  /** 服务端脱敏标记：该分组是否已配置 API Key（GET 无明文 apiKey） */
  hasApiKey?: boolean;
  baseUrl?: string | null;
  disable_response_chaining?: boolean;
  disable_prompt_cache_key?: boolean;
  protocol?: ModelProtocol;
  responses_transport?: ResponsesTransport;
  thinking?: unknown;
  reasoning_effort?: string;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  input_modalities?: Array<'text' | 'image'>;
  mcp_loading_mode?: McpLoadingMode;
  tool_search_protocol?: ToolSearchProtocol;
  /** 套餐用量查询来源（管控面凭据）；GET 只回 hasQuotaSecret */
  quotaSource?: EditableQuotaSource;
  models: EditableModel[];
};

export type EditableModelsConfig = {
  groups: EditableGroup[];
  default: string;
  allowCrossGroupSwitch: boolean;
  imageUnderstanding?: {
    model: string;
    fallbackModels?: string[];
    timeoutMs?: number;
  };
};

export type EditableMemoryIndexConfig = {
  enabled?: boolean;
  dbDir?: string;
  embedding: {
    baseUrl: string;
    /** 本地 draft：GET 不再回显明文，留空/缺失时服务端保留现有 Key */
    apiKey?: string;
    /** 服务端脱敏标记：embedding 是否已配置 API Key */
    hasApiKey?: boolean;
    model: string;
    dimensions: number;
  };
  chunking?: {
    tokens?: number;
    overlap?: number;
  };
  search?: {
    vectorWeight?: number;
    textWeight?: number;
    maxResults?: number;
    minScore?: number;
  };
  temporalDecay?: {
    enabled?: boolean;
    halfLifeDays?: number;
  };
  sync?: {
    debounceMs?: number;
  };
};

export type AdminModelsResponse = UtilityModelAdminFields & {
  writePolicy?: ConfigWritePolicy;
  revision: string;
  models: EditableModelsConfig;
  memoryIndex: EditableMemoryIndexConfig | null;
  publicModelList: ModelList;
};

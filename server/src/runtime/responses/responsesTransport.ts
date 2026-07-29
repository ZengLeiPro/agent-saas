import type {
  ModelChatMessage,
  ModelTerminalStatus,
  ModelToolDefinition,
  ModelUsage,
  RunContext,
} from '../types.js';

export type ResponsesTransportId = 'openai_compatible' | 'codex_subscription';

export interface ResponsesTransportCapabilities {
  responseState: 'stored' | 'stateless';
  terminalOutput: 'canonical' | 'stream_authoritative_when_missing';
  usageLookup: boolean;
  responseDelete: boolean;
  encryptedReasoning: boolean;
  omitToolConfigurationWhenEmpty: boolean;
  parallelToolCalls: boolean;
  maxOutputTokens: boolean;
}

export interface ProviderContinuationBinding {
  provider: 'openai_codex_subscription';
  issuer: string;
  accountBindingHash: string;
}

export interface ResponsesTransportExecuteInput {
  serializedBody: string;
  context: RunContext;
  clientRequestId: string;
  signal?: AbortSignal;
  /** Binding used while selecting opaque replay items; transport re-checks it before sending. */
  expectedContinuationBinding?: ProviderContinuationBinding;
}

export interface ResponsesTransportExecuteResult {
  response: Response;
  continuationBinding?: ProviderContinuationBinding;
  /** Account/issuer changed between replay selection and HTTP send, so opaque items were dropped. */
  continuationReplayReset?: boolean;
  /** OAuth 401 recovery is one logical model attempt but can contain one extra HTTP request. */
  authRetryCount?: number;
}

export interface ResponsesTransport {
  readonly id: ResponsesTransportId;
  readonly capabilities: ResponsesTransportCapabilities;

  computePromptCacheKey(input: {
    model: string;
    messages: ModelChatMessage[];
    tools: ModelToolDefinition[];
    context: RunContext;
  }): string | undefined;

  getContinuationBinding?(): Promise<ProviderContinuationBinding>;

  execute(input: ResponsesTransportExecuteInput): Promise<ResponsesTransportExecuteResult>;

  observeResult?(input: {
    model: string;
    terminalStatus: ModelTerminalStatus;
    usage?: ModelUsage;
    cacheEligible?: boolean;
    errorCode?: string;
  }): void;
  observeFailure?(input: { model: string; error: unknown }): void;

  getResponse?(responseId: string, signal?: AbortSignal): Promise<Response>;
  deleteResponse?(responseId: string, signal?: AbortSignal): Promise<Response>;
}

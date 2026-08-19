import type {
  ModelChatMessage,
  ModelTerminalStatus,
  ModelToolDefinition,
  ModelUsage,
  ModelWireMode,
  RunContext,
} from '../types.js';

export type ResponsesTransportId = 'openai_compatible' | 'codex_subscription';

export type ResponsesWireMode = ModelWireMode;

export interface ResponsesTransportStreamDiagnostic {
  wireMode: ResponsesWireMode;
  clientRequestId: string;
  webSocketErrorEmpty: boolean;
  closeCode?: number;
  closeReason?: string;
  requestDurationMs: number;
  frameCount: number;
  lastSequenceNumber?: number;
  officialTerminalReceived: boolean;
}

export class ResponsesTransportStreamError extends Error {
  constructor(
    message: string,
    readonly diagnostic: ResponsesTransportStreamDiagnostic,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ResponsesTransportStreamError';
  }
}

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
  /** Provider 用于 Prompt Cache 路由亲和的稳定内容指纹。 */
  promptCacheKey?: string;
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
  /** 实际 wire 传输形态；与模型上下文核算用的 responseMode 分离。 */
  wireMode?: ResponsesWireMode;
  /** 实际发到 provider 的 UTF-8 payload 大小；WebSocket relay 时小于 logical body。 */
  wireRequestBodyBytes?: number;
  /** WebSocket 不可用时回退 HTTP/SSE 的脱敏原因码。 */
  wireFallbackReason?: string;
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

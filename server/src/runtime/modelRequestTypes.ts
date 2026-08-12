import type { ModelOutputTransactionMode } from '../types/index.js';
import type { ModelRetryBlockedReason, ModelRetryReason } from './modelRetryTypes.js';

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * Reasoning 模型（gpt-5.5 / doubao / glm 等）的思考 token 数。
   * 注：这是 outputTokens 的**子集**，不额外计费——output 单价已覆盖。
   * 上游字段：Responses API `output_tokens_details.reasoning_tokens`
   *          Chat Completions `completion_tokens_details.reasoning_tokens`
   */
  reasoningTokens?: number;
  apiRequestCount?: number;
}

export type ModelTerminalStatus = 'completed' | 'incomplete' | 'failed' | 'cancelled';

export type ModelWireMode =
  | 'http_sse_full'
  | 'websocket_full'
  | 'websocket_relay'
  | 'websocket_fallback_full';

/** 模型请求实际采用的上下文传递方式。 */
export type ModelResponseMode = 'full' | 'relay' | 'fallback_full';

export type ModelRequestDiagnostic =
  | {
    type: 'started';
    modelRequestId: string;
    attemptId: string;
    attempt: number;
    clientRequestId: string;
    model: string;
    protocol: 'responses' | 'chat_completions';
    responseMode: ModelResponseMode;
    outputTransactionMode: ModelOutputTransactionMode;
    maxOutputTokens: number;
    requestBodyBytes: number;
    toolsCount: number;
    hasPreviousResponseId: boolean;
  }
  | {
    type: 'checkpoint';
    modelRequestId: string;
    attemptId: string;
    attempt: number;
    stage: 'response_created' | 'terminal_received';
    elapsedMs: number;
    responseIdHash?: string;
    actualModel?: string;
    terminalEventType?: string;
    terminalStatus?: ModelTerminalStatus;
    incompleteReason?: string;
    errorCode?: string;
  }
  | {
    type: 'finished';
    modelRequestId: string;
    attemptId: string;
    attempt: number;
    outcome:
      | 'completed'
      | 'http_error'
      | 'network_error'
      | 'aborted'
      | 'response_incomplete'
      | 'response_failed'
      | 'provider_error'
      | 'eof_without_terminal'
      | 'unterminated_tail'
      | 'parse_error'
      | 'stream_error';
    durationMs: number;
    httpStatus?: number;
    contentType?: string;
    upstreamRequestId?: string;
    responseIdHash?: string;
    responseBytes?: number;
    frameCount?: number;
    eventTypeCounts?: Record<string, number>;
    unknownEventTypes?: string[];
    receivedDone?: boolean;
    lastSequenceNumber?: number;
    terminalEventType?: string;
    terminalStatus?: ModelTerminalStatus;
    incompleteReason?: string;
    errorCode?: string;
    errorMessage?: string;
    tailBytes?: number;
    tailHash?: string;
    usage?: ModelUsage;
    outputTransactionMode?: ModelOutputTransactionMode;
    wireMode?: ModelWireMode;
    hasDeliveredOutput?: boolean;
    officialTerminalReceived?: boolean;
    retryReason?: ModelRetryReason;
    retryBlockedReason?: ModelRetryBlockedReason;
    webSocketErrorEmpty?: boolean;
    webSocketCloseCode?: number;
    webSocketCloseReason?: string;
    webSocketRequestDurationMs?: number;
    webSocketFrameCount?: number;
    webSocketLastSequenceNumber?: number;
    willRetry?: boolean;
  };

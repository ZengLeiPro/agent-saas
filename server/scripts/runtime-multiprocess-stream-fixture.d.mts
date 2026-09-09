import type WebSocket from 'ws';

export interface FakeOpenAIOptions {
  gateFinalText?: boolean;
  firstTextTimeoutMs?: number;
}

export interface FakeOpenAI {
  listen(port: number): Promise<number>;
  acknowledgeFirstText(): void;
  close(): Promise<void>;
  requestCount(): number;
}

export interface StreamingReplayOptions {
  sessionId: string;
  runId: string;
  acknowledgeFirstText(): void;
  timeoutMs?: number;
}

export interface StreamingReplayEnvelope {
  eventId?: number;
  eventCursor?: string;
  data?: Record<string, unknown>;
}

export function createFakeOpenAI(options?: FakeOpenAIOptions): FakeOpenAI;

export function collectStreamingReplay(
  ws: WebSocket,
  options: StreamingReplayOptions,
): Promise<StreamingReplayEnvelope[]>;

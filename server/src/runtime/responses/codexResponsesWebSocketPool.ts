import { createHash } from 'node:crypto';

import type {
  EgressWebSocket,
  EgressWebSocketConnector,
} from '../egressDispatcher.js';
import { ResponsesTransportStreamError } from './responsesTransport.js';

const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_EVENT_TIMEOUT_MS = 5 * 60_000;
const MAX_CONNECTION_AGE_MS = 55 * 60_000;
const IDLE_CONNECTION_TTL_MS = 15 * 60_000;
const MAX_POOL_ENTRIES = 200;
const CONNECT_FAILURE_COOLDOWNS_MS = [30_000, 2 * 60_000, 15 * 60_000] as const;

export type CodexWireMode = 'websocket_full' | 'websocket_relay' | 'websocket_fallback_full';

export interface CodexWebSocketExecuteInput {
  endpoint: string;
  accessToken: string;
  accountId: string;
  accountBindingHash: string;
  originator: string;
  serializedBody: string;
  tenantId: string;
  /** 平台会话标识：只用于本地连接池隔离，防止不同对话共享 WebSocket anchor。 */
  sessionId: string;
  /** 发给上游 session-id 的稳定内容指纹，用于 Prompt Cache 路由亲和。 */
  cacheAffinityId: string;
  clientRequestId: string;
  signal?: AbortSignal;
}

export interface CodexWebSocketExecuteResult {
  response: Response;
  wireMode: CodexWireMode;
  wireRequestBodyBytes: number;
}

interface RequestSnapshot {
  fingerprint: string;
  /** 上一轮 request input + server output items；下一轮必须以它为严格前缀。 */
  baselineItemHashes: string[];
  responseId: string;
}

interface PoolEntry {
  key: string;
  socket: EgressWebSocket;
  connectedAt: number;
  lastUsedAt: number;
  busy: boolean;
  closed: boolean;
  /** 并发旁路过 HTTP/SSE 后，当前 anchor 不再能证明覆盖完整线性历史。 */
  tainted: boolean;
  anchor?: RequestSnapshot;
}

interface RequestPlan {
  frame: string;
  mode: CodexWireMode;
  snapshot: {
    fingerprint: string;
    requestInputItemHashes: string[];
  };
  usedPreviousResponseId: boolean;
}

interface ActiveRequestResult extends CodexWebSocketExecuteResult {
  entry: PoolEntry;
}

export class CodexWebSocketUnavailableError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'CodexWebSocketUnavailableError';
  }
}

class CodexWebSocketReanchorError extends Error {
  constructor(readonly code: string) {
    super(`Codex WebSocket requires full-history re-anchor: ${code}`);
    this.name = 'CodexWebSocketReanchorError';
  }
}

/**
 * Codex Responses WebSocket 的进程内、会话级临时状态层。
 *
 * 这里从不成为会话事实源：调用方每轮仍传完整 logical body。只有同一 socket
 * 上的请求属性完全一致、input 严格追加时，才把 wire request 压成增量；任一
 * 状态不确定都丢弃 anchor，并以调用方提供的完整 body 重新锚定。
 */
export class CodexResponsesWebSocketPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly connectCooldowns = new Map<string, {
    until: number;
    reason: string;
    consecutiveFailures: number;
  }>();

  constructor(
    private readonly connector: EgressWebSocketConnector,
    private readonly options: {
      firstEventTimeoutMs?: number;
      idleEventTimeoutMs?: number;
      /** 首次握手偶发失败时原连接重试次数；总尝试次数默认 2。 */
      connectAttempts?: number;
      now?: () => number;
      logger?: { warn(message: string): void };
    } = {},
  ) {}

  async execute(input: CodexWebSocketExecuteInput): Promise<CodexWebSocketExecuteResult> {
    const logicalBody = parseLogicalBody(input.serializedBody);
    this.sweep();
    const key = poolKey(input);
    const cooldown = this.connectCooldowns.get(key);
    if (cooldown && cooldown.until > this.now()) {
      throw new CodexWebSocketUnavailableError(
        `Codex WebSocket 建连熔断中：${cooldown.reason}`,
        'connect_cooldown',
      );
    }
    let entry = this.entries.get(key);
    if (entry?.busy) {
      entry.tainted = true;
      throw new CodexWebSocketUnavailableError(
        '同一 Codex 会话已有在途 WebSocket response，降级 SSE 全量请求',
        'connection_busy',
      );
    }
    if (!entry && this.entries.size >= MAX_POOL_ENTRIES) {
      throw new CodexWebSocketUnavailableError(
        'Codex WebSocket 连接池已满，降级 SSE 全量请求',
        'pool_capacity',
      );
    }
    if (!entry || !isReusableEntry(entry, this.now())) {
      if (entry) this.discard(entry, 'connection_expired');
      entry = await this.connect(key, input);
    }

    const plan = buildRequestPlan(logicalBody, entry.anchor);
    try {
      const result = await this.startRequest(entry, input, plan);
      return result;
    } catch (error) {
      if (!(error instanceof CodexWebSocketReanchorError)) throw error;
      this.discard(entry, error.code);
      const replacement = await this.connect(key, input);
      const fullPlan = buildFullRequestPlan(logicalBody, 'websocket_fallback_full');
      try {
        return await this.startRequest(replacement, input, fullPlan);
      } catch (retryError) {
        this.discard(replacement, 'reanchor_failed');
        if (retryError instanceof CodexWebSocketReanchorError) {
          throw new CodexWebSocketUnavailableError(
            `Codex WebSocket 全量重锚仍失败：${retryError.code}`,
            retryError.code,
          );
        }
        throw retryError;
      }
    }
  }

  close(): void {
    for (const entry of this.entries.values()) this.discard(entry, 'pool_shutdown');
    this.entries.clear();
    this.connectCooldowns.clear();
  }

  private async connect(key: string, input: CodexWebSocketExecuteInput): Promise<PoolEntry> {
    const endpoint = new URL(input.endpoint);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: EgressWebSocket | undefined;
    let lastError: unknown;
    const connectAttempts = Math.max(1, Math.floor(this.options.connectAttempts ?? 2));
    for (let attempt = 1; attempt <= connectAttempts; attempt += 1) {
      try {
        socket = await this.connector({
          url: endpoint.toString(),
          headers: codexHeaders(input),
          signal: input.signal,
        });
        break;
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? error;
        lastError = error;
        if (attempt < connectAttempts && isRetryableConnectError(error)) {
          this.options.logger?.warn(
            `[CodexWebSocket] 第 ${attempt} 次连接失败，原出口重试：${compactError(error)}`,
          );
          continue;
        }
        break;
      }
    }
    if (!socket) {
      this.options.logger?.warn(
        `[CodexWebSocket] 连接失败，回退 HTTP/SSE：${compactError(lastError)}`,
      );
      const consecutiveFailures = (this.connectCooldowns.get(key)?.consecutiveFailures ?? 0) + 1;
      const cooldownMs = CONNECT_FAILURE_COOLDOWNS_MS[
        Math.min(consecutiveFailures - 1, CONNECT_FAILURE_COOLDOWNS_MS.length - 1)
      ] ?? CONNECT_FAILURE_COOLDOWNS_MS.at(-1)!;
      this.connectCooldowns.set(key, {
        until: this.now() + cooldownMs,
        reason: compactError(lastError),
        consecutiveFailures,
      });
      throw new CodexWebSocketUnavailableError(
        `Codex WebSocket 连接失败：${compactError(lastError)}`,
        'connect_failed',
      );
    }
    const now = this.now();
    const entry: PoolEntry = {
      key,
      socket,
      connectedAt: now,
      lastUsedAt: now,
      busy: false,
      closed: false,
      tainted: false,
    };
    this.connectCooldowns.delete(key);
    socket.addEventListener('close', () => {
      entry.closed = true;
      entry.anchor = undefined;
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this.entries.set(key, entry);
    return entry;
  }

  private startRequest(
    entry: PoolEntry,
    input: CodexWebSocketExecuteInput,
    plan: RequestPlan,
  ): Promise<ActiveRequestResult> {
    if (entry.busy || entry.closed || entry.socket.readyState !== 1) {
      throw new CodexWebSocketUnavailableError(
        'Codex WebSocket 不处于可发送状态',
        entry.busy ? 'connection_busy' : 'connection_closed',
      );
    }
    entry.busy = true;
    entry.lastUsedAt = this.now();

    const encoder = new TextEncoder();
    const requestStartedAt = this.now();
    let exposed = false;
    let settled = false;
    let terminal = false;
    let officialTerminalReceived = false;
    let frameCount = 0;
    let lastSequenceNumber: number | undefined;
    let pendingSocketError: { detail: string; empty: boolean } | undefined;
    let socketErrorSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let firstEventTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const bufferedFrames: Uint8Array[] = [];
    const streamedOutputItems: unknown[] = [];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
      cancel: () => {
        if (!terminal) this.discard(entry, 'response_consumer_cancelled');
      },
    });

    return new Promise<ActiveRequestResult>((resolve, reject) => {
      const cleanup = () => {
        if (socketErrorSettleTimer) clearTimeout(socketErrorSettleTimer);
        if (firstEventTimer) clearTimeout(firstEventTimer);
        if (idleTimer) clearTimeout(idleTimer);
        input.signal?.removeEventListener('abort', onAbort);
        entry.socket.removeEventListener('message', onMessage);
        entry.socket.removeEventListener('error', onSocketError);
        entry.socket.removeEventListener('close', onSocketClose);
        entry.busy = false;
        entry.lastUsedAt = this.now();
      };

      const rejectBeforeExpose = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        controllerRef?.close();
        reject(error);
      };

      const failStream = (error: Error, preExposureReason?: string) => {
        if (terminal) return;
        terminal = true;
        entry.anchor = undefined;
        cleanup();
        if (!exposed) {
          rejectBeforeExpose(preExposureReason
            ? new CodexWebSocketUnavailableError(error.message, preExposureReason)
            : error);
          return;
        }
        controllerRef?.error(error);
      };

      const expose = () => {
        if (exposed || settled) return;
        exposed = true;
        settled = true;
        if (firstEventTimer) clearTimeout(firstEventTimer);
        for (const frame of bufferedFrames) controllerRef?.enqueue(frame);
        bufferedFrames.length = 0;
        resolve({
          entry,
          response: new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          }),
          wireMode: plan.mode,
          wireRequestBodyBytes: Buffer.byteLength(plan.frame, 'utf8'),
        });
      };

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          failStream(
            new Error('Codex WebSocket idle timeout waiting for response event'),
            'idle_timeout',
          );
          this.discard(entry, 'idle_timeout');
        }, this.options.idleEventTimeoutMs ?? DEFAULT_IDLE_EVENT_TIMEOUT_MS);
        idleTimer.unref?.();
      };

      const finishTerminal = (event: Record<string, unknown>, eventType: string) => {
        terminal = true;
        officialTerminalReceived = true;
        if (isSuccessfulTerminal(event, eventType) && !entry.tainted) {
          const responseId = responseIdFromEvent(event);
          const terminalOutput = responseOutputFromEvent(event);
          const outputItems = terminalOutput && terminalOutput.length > 0
            ? terminalOutput
            : streamedOutputItems.length > 0
              ? streamedOutputItems
              : terminalOutput;
          if (responseId && outputItems) {
            entry.anchor = {
              fingerprint: plan.snapshot.fingerprint,
              baselineItemHashes: [
                ...plan.snapshot.requestInputItemHashes,
                ...outputItems.map((item) => sha256(JSON.stringify(normalizeResponseOutputItem(item)))),
              ],
              responseId,
            };
          } else {
            entry.anchor = undefined;
          }
        } else {
          entry.anchor = undefined;
        }
        entry.tainted = false;
        const doneFrame = encoder.encode('data: [DONE]\n\n');
        if (exposed) controllerRef?.enqueue(doneFrame);
        else bufferedFrames.push(doneFrame);
        cleanup();
        controllerRef?.close();
      };

      const onMessage: NonNullable<EgressWebSocket['onmessage']> = (raw) => {
        resetIdleTimer();
        frameCount += 1;
        const text = websocketMessageText(raw.data);
        if (text === undefined) {
          failStream(
            new Error('Codex WebSocket returned unsupported binary event'),
            'binary_event',
          );
          this.discard(entry, 'binary_event');
          return;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(text) as Record<string, unknown>;
        } catch (error) {
          failStream(
            new Error(`Codex WebSocket JSON parse failed: ${compactError(error)}`),
            'invalid_json',
          );
          this.discard(entry, 'invalid_json');
          return;
        }
        const eventType = typeof event.type === 'string' ? event.type : '';
        if (typeof event.sequence_number === 'number' && Number.isFinite(event.sequence_number)) {
          lastSequenceNumber = event.sequence_number;
        }
        const code = errorCodeFromEvent(event);
        const status = eventStatus(event);
        if (!exposed && status === 401) {
          rejectBeforeExpose(new CodexWebSocketUnavailableError(
            'Codex WebSocket authentication failed',
            'authentication_failed',
          ));
          this.discard(entry, 'authentication_failed');
          return;
        }
        if (
          !exposed
          && (plan.usedPreviousResponseId || code === 'websocket_connection_limit_reached')
          && (code === 'previous_response_not_found' || code === 'websocket_connection_limit_reached')
        ) {
          rejectBeforeExpose(new CodexWebSocketReanchorError(code));
          return;
        }

        const frame = encoder.encode(`event: ${eventType || 'message'}\ndata: ${text}\n\n`);
        if (exposed) controllerRef?.enqueue(frame);
        else bufferedFrames.push(frame);

        if (isResponseStartEvent(eventType)) expose();
        if (eventType === 'response.output_item.done' && event.item !== undefined) {
          streamedOutputItems.push(event.item);
        }
        if (isTerminalEvent(eventType)) {
          expose();
          finishTerminal(event, eventType);
        }
      };

      const failSocketInterruption = (close?: { code: number; reason: string }) => {
        if (terminal) return;
        const socketError = pendingSocketError;
        const closeReason = close?.reason ? compactError(close.reason) : undefined;
        const detail = socketError?.empty === false ? socketError.detail : undefined;
        const message = [
          detail ?? (socketError ? 'Codex WebSocket error without diagnostic detail' : undefined),
          close
            ? `closed before terminal event (code=${close.code} reason=${closeReason ?? 'none'})`
            : undefined,
        ].filter(Boolean).join('; ') || 'Codex WebSocket closed before terminal event';
        failStream(new ResponsesTransportStreamError(message, {
          wireMode: plan.mode,
          clientRequestId: input.clientRequestId,
          webSocketErrorEmpty: socketError?.empty ?? false,
          ...(close ? { closeCode: close.code } : {}),
          ...(closeReason ? { closeReason } : {}),
          requestDurationMs: Math.max(0, this.now() - requestStartedAt),
          frameCount,
          ...(lastSequenceNumber !== undefined ? { lastSequenceNumber } : {}),
          officialTerminalReceived,
        }), socketError ? 'socket_error' : 'connection_closed');
        if (!close) this.discard(entry, socketError ? 'socket_error' : 'connection_closed');
      };
      const onSocketError = (event: Event) => {
        if (terminal || pendingSocketError) return;
        const candidate = event as Event & { error?: unknown; message?: string };
        const detail = compactError(candidate.error ?? candidate.message);
        pendingSocketError = { detail, empty: detail === 'unknown_error' };
        if (socketErrorSettleTimer) return;
        // Undici 8.9 在底层连接异常时同步先发 error、再发 close（其 #onSocketClose）。
        // 额外容纳实现把 close 排到下一任务的情况；若只发 error，0ms timer 仍会关闭连接
        // 并由 cleanup 清理全部 request listener/timer。
        socketErrorSettleTimer = setTimeout(() => failSocketInterruption(), 25);
        socketErrorSettleTimer.unref?.();
      };
      const onSocketClose = (event: CloseEvent) => {
        if (terminal) return;
        failSocketInterruption({ code: event.code, reason: event.reason });
      };
      const onAbort = () => {
        failStream(input.signal?.reason instanceof Error
          ? input.signal.reason
          : new DOMException('Aborted', 'AbortError'));
        this.discard(entry, 'request_aborted');
      };

      entry.socket.addEventListener('message', onMessage);
      entry.socket.addEventListener('error', onSocketError);
      entry.socket.addEventListener('close', onSocketClose);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      firstEventTimer = setTimeout(() => {
        failStream(
          new Error('Codex WebSocket timeout waiting for first response event'),
          'first_event_timeout',
        );
        this.discard(entry, 'first_event_timeout');
      }, this.options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS);
      firstEventTimer.unref?.();
      resetIdleTimer();

      try {
        entry.socket.send(plan.frame);
      } catch (error) {
        failStream(
          new Error(`Codex WebSocket send failed: ${compactError(error)}`),
          'send_failed',
        );
        this.discard(entry, 'send_failed');
      }
    });
  }

  private discard(entry: PoolEntry, reason: string): void {
    entry.closed = true;
    entry.anchor = undefined;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    try { entry.socket.close(1000, reason.slice(0, 120)); } catch { /* already closed */ }
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, cooldown] of this.connectCooldowns) {
      // 过期后仍保留短期失败计数，下一次失败才能升级退避；成功建连会立即清零。
      if (cooldown.until <= now - 60 * 60_000) this.connectCooldowns.delete(key);
    }
    for (const entry of this.entries.values()) {
      if (!isReusableEntry(entry, now) || (!entry.busy && now - entry.lastUsedAt > IDLE_CONNECTION_TTL_MS)) {
        this.discard(entry, 'pool_sweep');
      }
    }
    if (this.entries.size < MAX_POOL_ENTRIES) return;
    const idle = Array.from(this.entries.values())
      .filter((entry) => !entry.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of idle) {
      if (this.entries.size < MAX_POOL_ENTRIES) break;
      this.discard(entry, 'pool_capacity');
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function parseLogicalBody(serializedBody: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(serializedBody);
  } catch (error) {
    throw new CodexWebSocketUnavailableError(
      `Codex logical request JSON 无效：${compactError(error)}`,
      'invalid_request_json',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CodexWebSocketUnavailableError('Codex logical request 必须是 JSON object', 'invalid_request');
  }
  if (!Array.isArray((body as Record<string, unknown>).input)) {
    throw new CodexWebSocketUnavailableError('Codex logical request 缺少 input 数组', 'invalid_input');
  }
  return body as Record<string, unknown>;
}

function buildRequestPlan(body: Record<string, unknown>, anchor?: RequestSnapshot): RequestPlan {
  const snapshot = requestSnapshot(body);
  if (
    anchor
    && anchor.fingerprint === snapshot.fingerprint
    && isStrictPrefix(anchor.baselineItemHashes, snapshot.requestInputItemHashes)
  ) {
    const input = body.input as unknown[];
    return buildFrame(
      body,
      input.slice(anchor.baselineItemHashes.length),
      'websocket_relay',
      snapshot,
      anchor.responseId,
    );
  }
  return buildFullRequestPlan(body, 'websocket_full');
}

function buildFullRequestPlan(
  body: Record<string, unknown>,
  mode: 'websocket_full' | 'websocket_fallback_full',
): RequestPlan {
  return buildFrame(body, body.input as unknown[], mode, requestSnapshot(body));
}

function buildFrame(
  body: Record<string, unknown>,
  input: unknown[],
  mode: CodexWireMode,
  snapshot: RequestPlan['snapshot'],
  previousResponseId?: string,
): RequestPlan {
  const payload = {
    ...body,
    type: 'response.create',
    input,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
  };
  if (!previousResponseId) delete (payload as Record<string, unknown>).previous_response_id;
  return {
    frame: JSON.stringify(payload),
    mode,
    snapshot,
    usedPreviousResponseId: previousResponseId !== undefined,
  };
}

function requestSnapshot(body: Record<string, unknown>): RequestPlan['snapshot'] {
  const comparable = { ...body };
  delete comparable.input;
  delete comparable.previous_response_id;
  const input = body.input as unknown[];
  return {
    fingerprint: sha256(JSON.stringify(comparable)),
    requestInputItemHashes: input.map((item) => sha256(JSON.stringify(item))),
  };
}

function isStrictPrefix(previous: string[], current: string[]): boolean {
  if (current.length <= previous.length) return false;
  return previous.every((hash, index) => current[index] === hash);
}

function poolKey(input: CodexWebSocketExecuteInput): string {
  return sha256(JSON.stringify([
    input.tenantId,
    input.sessionId,
    input.cacheAffinityId,
    input.endpoint,
    input.accountBindingHash,
  ]));
}

function codexHeaders(input: CodexWebSocketExecuteInput): Record<string, string> {
  return {
    authorization: `Bearer ${input.accessToken}`,
    'chatgpt-account-id': input.accountId,
    originator: input.originator,
    'user-agent': `${input.originator}/0.0.0 (${process.platform}; ${process.arch}) kaiyan-agent`,
    // Codex 私有 endpoint 的 WebSocket v2 握手值；HTTP/SSE 仍沿用 responses=experimental。
    // 该值与 openai/codex 当前 build_websocket_headers 保持一致。
    'openai-beta': 'responses_websockets=2026-02-06',
    'session-id': input.cacheAffinityId,
    'x-client-request-id': input.clientRequestId,
  };
}

function isReusableEntry(entry: PoolEntry, now: number): boolean {
  return !entry.closed
    && entry.socket.readyState === 1
    && now - entry.connectedAt < MAX_CONNECTION_AGE_MS;
}

function isResponseStartEvent(type: string): boolean {
  return type === 'response.created'
    || type.startsWith('response.output_')
    || type.startsWith('response.reasoning_')
    || type.startsWith('response.function_call_');
}

function isTerminalEvent(type: string): boolean {
  return type === 'response.completed'
    || type === 'response.done'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'response.cancelled'
    || type === 'response.error'
    || type === 'error';
}

function isSuccessfulTerminal(event: Record<string, unknown>, type: string): boolean {
  if (type !== 'response.completed' && type !== 'response.done') return false;
  const response = event.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  const status = (response as Record<string, unknown>).status;
  return status === undefined || status === 'completed';
}

function responseIdFromEvent(event: Record<string, unknown>): string | undefined {
  const response = event.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const id = (response as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function responseOutputFromEvent(event: Record<string, unknown>): unknown[] | undefined {
  const response = event.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const output = (response as Record<string, unknown>).output;
  return Array.isArray(output) ? output : undefined;
}

/** 映射为 ResponsesApiAdapter 下一轮 full-history 会构造的 input item 形态。 */
function normalizeResponseOutputItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const value = item as Record<string, unknown>;
  if (value.type === 'reasoning') {
    return {
      type: 'reasoning',
      ...(typeof value.encrypted_content === 'string'
        ? { encrypted_content: value.encrypted_content }
        : {}),
      ...(Array.isArray(value.summary) ? { summary: value.summary } : {}),
    };
  }
  if (value.type === 'function_call') {
    return {
      type: 'function_call',
      call_id: value.call_id,
      name: value.name,
      arguments: value.arguments,
      ...(typeof value.namespace === 'string' ? { namespace: value.namespace } : {}),
    };
  }
  if (value.type === 'message' && value.role === 'assistant' && Array.isArray(value.content)) {
    const content = value.content.map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
      const block = part as Record<string, unknown>;
      if (block.type !== 'output_text' || typeof block.text !== 'string') return part;
      return { type: 'output_text', text: block.text };
    });
    return { type: 'message', role: 'assistant', content };
  }
  // 未知原生 item 保留原形：若平台 full-history 没有同形 item，前缀比较会失败并安全全量重锚。
  return item;
}

function errorCodeFromEvent(event: Record<string, unknown>): string | undefined {
  const direct = event.code;
  if (typeof direct === 'string') return direct;
  const error = event.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const nested = (error as Record<string, unknown>).code;
  return typeof nested === 'string' ? nested : undefined;
}

function eventStatus(event: Record<string, unknown>): number | undefined {
  if (typeof event.status === 'number') return event.status;
  return typeof event.status_code === 'number' ? event.status_code : undefined;
}

function websocketMessageText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? ''))
    .replace(/((?:"|')?(?:api[_-]?key|authorization|cookie|set-cookie|access_token|refresh_token|id_token)(?:"|')?\s*:\s*)(?:"[^"]*"|'[^']*')/gi, '$1"[REDACTED]"')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(https?:\/\/)(?:[^@\s/]+@)?([^?\s#]+)\?[^\s#]*/gi, '$1$2?[REDACTED]')
    .replace(/\b(https?:\/\/)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || 'unknown_error';
}

function isRetryableConnectError(error: unknown): boolean {
  const message = compactError(error).toLowerCase();
  return message.includes('empty errorevent')
    || message.includes('network error or non-101')
    || message.includes('network error or non-200');
}

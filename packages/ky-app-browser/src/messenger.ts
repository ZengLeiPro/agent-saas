/**
 * §5.3 信封收发：精确 `targetOrigin`、入站来源校验、需应答消息的 5 s 超时、
 * 重复 `(type,id)` 重放缓存应答。
 */
import {
  MESSAGE_NAMESPACE,
  MESSAGE_NAMESPACE_EXPERIMENTAL,
  MESSAGE_RESPONSE_PAIRS,
  MESSAGE_RESPONSE_TIMEOUT_MS,
  MESSAGE_VERSION,
  SHELL_TO_APP_MESSAGE_TYPES,
  type KyMessageEnvelope,
} from '@kaiyan/ky-app-contract';

import { KyTimeoutError } from './errors.js';
import { ReplyCache } from './replyCache.js';
import type {
  KyCounters,
  KyMessageEventLike,
  KyMessageListener,
  KyTimerHandle,
  KyTimers,
  KyWindowLike,
} from './types.js';

/** 收发两端都用的宽松信封（具体 payload 由各处理器自行收窄）。 */
export type AnyEnvelope = KyMessageEnvelope<string, unknown>;

export interface InboundContext {
  /** 该消息是否已经作为某个在途请求的应答被消费。 */
  matchedPending: boolean;
}

export type InboundHandler = (
  message: AnyEnvelope,
  context: InboundContext,
) => AnyEnvelope | undefined | Promise<AnyEnvelope | undefined>;

export interface MessengerDeps {
  window: KyWindowLike;
  /** 精确 targetOrigin；`null` 表示未知 → 一条消息都不发。 */
  shellOrigin: string | null;
  timers: KyTimers;
  counters: KyCounters;
  /** 处理器抛错时的兜底上报。 */
  onHandlerError?: (type: string, error: unknown) => void;
}

interface PendingEntry {
  expect: readonly string[];
  timer: KyTimerHandle;
  resolve: (envelope: AnyEnvelope) => void;
  reject: (error: unknown) => void;
}

const SHELL_TYPES: ReadonlySet<string> = new Set<string>(SHELL_TO_APP_MESSAGE_TYPES);

export class Messenger {
  readonly #deps: MessengerDeps;
  readonly #handlers = new Map<string, InboundHandler>();
  readonly #pending = new Map<string, PendingEntry>();
  readonly #replies = new ReplyCache<Promise<AnyEnvelope | undefined>>(100);
  #idSeq = 0;
  #started = false;
  #destroyed = false;

  constructor(deps: MessengerDeps) {
    this.#deps = deps;
  }

  /** 注册入站监听。`shellOrigin` 未知时不监听也不发送。 */
  start(): void {
    if (this.#started || this.#destroyed || this.#deps.shellOrigin === null) return;
    this.#started = true;
    this.#deps.window.addEventListener('message', this.#listener);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#started) this.#deps.window.removeEventListener('message', this.#listener);
    for (const [id, entry] of this.#pending) {
      this.#deps.timers.clearTimeout(entry.timer);
      this.#pending.delete(id);
      entry.reject(new KyTimeoutError('destroyed'));
    }
    this.#replies.clear();
  }

  on(type: string, handler: InboundHandler): void {
    this.#handlers.set(type, handler);
  }

  nextId(prefix: string): string {
    this.#idSeq += 1;
    const salt = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${this.#idSeq}-${salt}`;
  }

  /** 单向发送。`shellOrigin` 未知 → 静默丢弃（调用方已在 createKyApp 阶段报过错）。 */
  post(
    type: string,
    payload?: unknown,
    options?: { id?: string; navId?: string },
  ): AnyEnvelope | undefined {
    const envelope: AnyEnvelope = {
      ns: MESSAGE_NAMESPACE,
      v: MESSAGE_VERSION,
      type,
      ...(options?.id === undefined ? {} : { id: options.id }),
      ...(options?.navId === undefined ? {} : { navId: options.navId }),
      ...(payload === undefined ? {} : { payload }),
    };
    this.postEnvelope(envelope);
    return envelope;
  }

  postEnvelope(envelope: AnyEnvelope): void {
    const { shellOrigin } = this.#deps;
    if (this.#destroyed || shellOrigin === null) return;
    this.#deps.window.parent.postMessage(envelope, shellOrigin);
  }

  /**
   * 需应答消息：顶层 `id` 关联，默认 5 s 超时（§5.3）。
   * `id` 可由调用方指定，用于重发时复用同一 `id`。
   */
  request(
    type: string,
    payload?: unknown,
    options?: { id?: string; timeoutMs?: number },
  ): Promise<AnyEnvelope> {
    const expect = MESSAGE_RESPONSE_PAIRS[type as keyof typeof MESSAGE_RESPONSE_PAIRS] as
      readonly string[] | undefined;
    if (expect === undefined) {
      return Promise.reject(new KyTimeoutError(`${type} 不是需应答消息`));
    }
    if (this.#destroyed || this.#deps.shellOrigin === null) {
      return Promise.reject(new KyTimeoutError(type));
    }
    const id = options?.id ?? this.nextId(type);
    const timeoutMs = options?.timeoutMs ?? MESSAGE_RESPONSE_TIMEOUT_MS;
    return new Promise<AnyEnvelope>((resolve, reject) => {
      const timer = this.#deps.timers.setTimeout(() => {
        this.#pending.delete(id);
        this.#deps.counters.requestTimeouts += 1;
        reject(new KyTimeoutError(type));
      }, timeoutMs);
      this.#pending.set(id, { expect, timer, resolve, reject });
      this.post(type, payload, { id });
    });
  }

  readonly #listener: KyMessageListener = (event: KyMessageEventLike) => {
    if (this.#destroyed) return;
    const counters = this.#deps.counters;
    if (event.origin !== this.#deps.shellOrigin) {
      counters.droppedOrigin += 1;
      return;
    }
    if (event.source !== this.#deps.window.parent) {
      counters.droppedSource += 1;
      return;
    }
    const data = event.data;
    if (typeof data !== 'object' || data === null) {
      counters.droppedNamespace += 1;
      return;
    }
    const record = data as Record<string, unknown>;
    if (record.ns === MESSAGE_NAMESPACE_EXPERIMENTAL) {
      // §5.4：`context.set` 移至 ky-experimental，默认关闭 → 一律丢弃并计数。
      counters.droppedExperimental += 1;
      return;
    }
    if (record.ns !== MESSAGE_NAMESPACE) {
      counters.droppedNamespace += 1;
      return;
    }
    if (record.v !== MESSAGE_VERSION) {
      counters.droppedVersion += 1;
      return;
    }
    const type = record.type;
    if (typeof type !== 'string' || !SHELL_TYPES.has(type)) {
      counters.droppedType += 1;
      return;
    }
    this.#dispatch(record as unknown as AnyEnvelope, type);
  };

  #dispatch(envelope: AnyEnvelope, type: string): void {
    const id = typeof envelope.id === 'string' ? envelope.id : undefined;
    const matchedPending = id === undefined ? false : this.#resolvePending(id, type, envelope);
    const handler = this.#handlers.get(type);
    if (handler === undefined) return;
    if (id === undefined) {
      void this.#run(handler, envelope, { matchedPending });
      return;
    }
    const key = ReplyCache.key(type, id);
    const cached = this.#replies.get(key);
    if (cached !== undefined) {
      this.#deps.counters.replayedReplies += 1;
      void cached.then((reply) => {
        if (reply !== undefined) this.postEnvelope(reply);
      });
      return;
    }
    const pending = this.#run(handler, envelope, { matchedPending });
    this.#replies.set(key, pending);
    void pending.then((reply) => {
      if (reply !== undefined) this.postEnvelope(reply);
    });
  }

  async #run(
    handler: InboundHandler,
    envelope: AnyEnvelope,
    context: InboundContext,
  ): Promise<AnyEnvelope | undefined> {
    try {
      return await handler(envelope, context);
    } catch (error) {
      this.#deps.onHandlerError?.(envelope.type, error);
      return undefined;
    }
  }

  #resolvePending(id: string, type: string, envelope: AnyEnvelope): boolean {
    const entry = this.#pending.get(id);
    if (entry === undefined || !entry.expect.includes(type)) return false;
    this.#pending.delete(id);
    this.#deps.timers.clearTimeout(entry.timer);
    entry.resolve(envelope);
    return true;
  }
}

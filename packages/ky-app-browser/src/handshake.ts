/**
 * §5.4 握手状态机：`loading → attesting → ready(每 1 s 重发, ≤ 10 s) → init → active`。
 *
 * - `attesting`：请求自身 `GET /ky/v1/attest?nonce=` 拿 attest JWT，重发复用同一份。
 * - `ready`：`{contractVersion, path, installationId, attestation}`，`path` 用 contract 的
 *   `normalizeAppPath()` 规范化（已剔除 `ky`/`ky_iid`/`ky_nonce`）。
 * - `init`：存令牌 → 回 `init.ack` → `active`；`init` 幂等可重发，重复只更新令牌并再次
 *   `init.ack`，不重复触发 `onInit`。
 * - 10 s 仍未收到 `init` → `failed`。
 */
import {
  CONTRACT_VERSION,
  HANDSHAKE_READY_RESEND_INTERVAL_MS,
  HANDSHAKE_READY_TIMEOUT_MS,
  MESSAGE_NAMESPACE,
  MESSAGE_VERSION,
  type InitPayload,
  type ReadyPayload,
} from '@kaiyan/ky-app-contract/browser';

import type { AnyEnvelope, Messenger } from './messenger.js';
import type { TokenManager } from './tokenManager.js';
import type {
  KyCounters,
  KyErrorInfo,
  KyInitContext,
  KyPhase,
  KyTimerHandle,
  KyTimers,
} from './types.js';

export interface HandshakeDeps {
  messenger: Messenger;
  tokens: TokenManager;
  timers: KyTimers;
  counters: KyCounters;
  now: () => number;
  fetchImpl: typeof fetch;
  attestUrl: string;
  installationId: string;
  nonce: string;
  path: string;
  onPhase: (phase: KyPhase) => void;
  onInit: (context: KyInitContext) => void;
  onError: (error: KyErrorInfo) => void;
}

export class Handshake {
  readonly #deps: HandshakeDeps;
  #phase: KyPhase = 'loading';
  #attestation: string | null = null;
  #readyId: string | null = null;
  #resendTimer: KyTimerHandle = null;
  #deadlineTimer: KyTimerHandle = null;
  #startedAt = 0;
  #initApplied = false;
  #destroyed = false;
  #settled = false;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: unknown) => void) | null = null;
  readonly #readyPromise: Promise<void>;

  constructor(deps: HandshakeDeps) {
    this.#deps = deps;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // 未被消费的 rejection 不应污染宿主页面；调用方通过 app.ready() 显式等待。
    this.#readyPromise.catch(() => undefined);
  }

  get phase(): KyPhase {
    return this.#phase;
  }

  /** 等待握手完成（`active`）；失败时 reject。 */
  waitReady(): Promise<void> {
    return this.#readyPromise;
  }

  async start(): Promise<void> {
    this.#setPhase('attesting');
    try {
      this.#attestation = await this.#fetchAttestation();
    } catch (error) {
      this.#fail('attest_failed', `获取安装证明失败：${describe(error)}`);
      return;
    }
    if (this.#destroyed || this.#settled) return;
    this.#setPhase('ready');
    // 10 s 预算从第一条 ready 起算，不含 attest 的耗时。
    this.#startedAt = this.#deps.now();
    this.#readyId = this.#deps.messenger.nextId('ready');
    this.#postReady();
    this.#scheduleResend();
    this.#deadlineTimer = this.#deps.timers.setTimeout(() => {
      this.#deadlineTimer = null;
      this.#fail('handshake_timeout', '10 s 内没有收到 init');
    }, HANDSHAKE_READY_TIMEOUT_MS);
  }

  /** 处理入站 `init`，返回要回给壳的 `init.ack` 信封。 */
  handleInit(envelope: AnyEnvelope): AnyEnvelope | undefined {
    const payload = envelope.payload as InitPayload | undefined;
    if (payload === undefined || typeof payload.token !== 'string') return undefined;
    if (payload.contractVersion !== CONTRACT_VERSION) {
      this.#fail(
        'contract_version_mismatch',
        `壳声明的 contractVersion=${String(payload.contractVersion)}，本 SDK 只实现 1`,
      );
      return undefined;
    }
    this.#setPhase('init');
    this.#clearTimers();
    // 幂等：令牌每次都更新，onInit 只触发一次。
    this.#deps.tokens.accept({ token: payload.token, tokenExp: payload.tokenExp });
    const ack: AnyEnvelope = {
      ns: MESSAGE_NAMESPACE,
      v: MESSAGE_VERSION,
      type: 'init.ack',
      ...(typeof envelope.id === 'string' ? { id: envelope.id } : {}),
    };
    if (!this.#initApplied) {
      this.#initApplied = true;
      this.#deps.onInit(payload);
    }
    this.#setPhase('active');
    this.#settle();
    return ack;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#clearTimers();
    if (!this.#settled) {
      this.#settled = true;
      this.#rejectReady?.(new Error('KyApp 已销毁'));
    }
  }

  async #fetchAttestation(): Promise<string> {
    const url = `${this.#deps.attestUrl}?nonce=${encodeURIComponent(this.#deps.nonce)}`;
    const response = await this.#deps.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const body: unknown = await response.json();
    const attestation = (body as { attestation?: unknown } | null)?.attestation;
    if (typeof attestation !== 'string' || attestation === '') {
      throw new Error('响应缺少 attestation 字段');
    }
    return attestation;
  }

  #postReady(): void {
    if (this.#attestation === null || this.#readyId === null) return;
    const payload: ReadyPayload = {
      contractVersion: CONTRACT_VERSION,
      path: this.#deps.path,
      installationId: this.#deps.installationId,
      attestation: this.#attestation,
    };
    this.#deps.messenger.post('ready', payload, { id: this.#readyId });
  }

  #scheduleResend(): void {
    if (this.#destroyed || this.#settled) return;
    this.#resendTimer = this.#deps.timers.setTimeout(() => {
      this.#resendTimer = null;
      if (this.#destroyed || this.#settled) return;
      if (this.#deps.now() - this.#startedAt >= HANDSHAKE_READY_TIMEOUT_MS) return;
      this.#deps.counters.readyResends += 1;
      this.#postReady();
      this.#scheduleResend();
    }, HANDSHAKE_READY_RESEND_INTERVAL_MS);
  }

  #clearTimers(): void {
    this.#deps.timers.clearTimeout(this.#resendTimer);
    this.#resendTimer = null;
    this.#deps.timers.clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = null;
  }

  #fail(code: KyErrorInfo['code'], message: string): void {
    if (this.#settled) return;
    this.#clearTimers();
    this.#setPhase('failed');
    this.#settled = true;
    this.#deps.onError({ code, message });
    this.#rejectReady?.(new Error(message));
  }

  #settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveReady?.();
  }

  #setPhase(phase: KyPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#deps.onPhase(phase);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

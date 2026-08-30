/**
 * WebSocket Client - platform-agnostic singleton WS connection manager
 *
 * Supports:
 * - JWT auth via a controlled first frame after the bare WebSocket upgrade
 * - Auto-reconnect with exponential backoff
 * - Message send/receive
 * - Connection state management
 * - Reference-counted connections (acquire/release)
 * - Application-level heartbeat (ping/pong)
 * - Connect timeout guard
 * - Auth failure detection
 */

import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';
import type { SandboxProfile } from '../types/session';
import type { WsEvent } from '../types/ws';
import {
    createSyncRecoveryState,
    reduceSyncRecovery,
    type SyncRecoveryState,
} from './syncRecovery';
import type {
    CanonicalChatSubmissionWireMessage,
    ChatClientCapability,
} from './chatSubmission';

export type WsState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WsMessageHandler = (data: any) => void;
export type WsStateHandler = (state: WsState) => void;

/** Outbound message types */
interface WsChatControlFields {
    /** 内部管理员验收开关：选择工具执行后端。普通 UI 不暴露。 */
    executionTarget?: 'server-local' | 'server-container';
    approvalPolicy?: {
        autoApproveTools?: boolean;
        autoApproveRunShell?: boolean;
        /** 「低风险常开」档：自动批准上限到 workspace_write，dangerous 仍人工批准。 */
        lowRiskOnly?: boolean;
    };
}

/** M20-01 canonical chat wire message. Path-shaped attachment fields are not representable. */
export type CanonicalWsChatMessage = CanonicalChatSubmissionWireMessage & WsChatControlFields;

/** @deprecated N-1 only. Never construct this from the M20-01 canonical adapter. */
export interface LegacyWsChatAttachment {
    attachmentId?: string;
    originalName: string;
    /** @deprecated Server compatibility lookup only; never authoritative. */
    savedPath?: string;
    /** @deprecated Server compatibility lookup only; never authoritative. */
    relativePath: string;
    size: number;
    mimeType: string;
    isImage: boolean;
}

/** @deprecated N-1 chat envelope. New Mobile/Web code must use CanonicalWsChatMessage. */
export interface LegacyWsChatMessage extends WsChatControlFields {
    action: 'chat';
    deliveryMode?: 'queue' | 'steer';
    clientCapabilities?: ChatClientCapability[];
    client_msg_id?: string;
    message: string;
    sessionId?: string;
    /** Only honored when creating a session; persisted profile wins on continuation. */
    sandboxProfile?: SandboxProfile;
    orgAgentId?: string;
    attachments?: LegacyWsChatAttachment[];
    model?: string;
}

export type WsChatMessage = CanonicalWsChatMessage | LegacyWsChatMessage;

export interface WsRespondMessage {
  action: 'respond';
  interactionId: string;
  sessionId?: string | null;
  requestId?: string;
  clientAttemptId?: string;
  response?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WsAbortMessage {
    action: 'abort';
    runId?: string;
    streamId?: string;
}

export interface WsApprovalPolicyMessage {
    action: 'approval_policy';
    sessionId?: string;
    runId?: string;
    approvalPolicy?: {
        autoApproveTools?: boolean;
        autoApproveRunShell?: boolean;
        lowRiskOnly?: boolean;
    };
}

export interface WsResumeMessage {
    action: 'resume';
    sessionId: string;
    /** Correlates the active_stream response with this exact resume attempt. */
    requestId?: string;
    lastEventId: number;
    lastEventCursor?: string | null;
    skipReplay?: boolean;
}

export interface WsRunStatusMessage {
    action: 'run_status';
    runId: string;
}

export interface WsDetachMessage {
    action: 'detach';
}

export interface WsSyncMessage {
    action: 'sync';
    lastSeq: number;
    /** 上次见到的服务端用户日志代际；旧服务端会忽略。 */
    epoch?: string;
    /** 当前会话；新服务端可在 overflow 中内联其权威快照。 */
    sessionId?: string;
}

/** 撤回一条仍在排队（未被目标 run 消费）的插话（2026-08-04 终态设计）。 */
export interface WsCancelQueuedMessage {
    action: 'cancel_queued';
    sourceRunId: string;
}

export type WsOutboundMessage =
    | WsChatMessage
    | WsRespondMessage
    | WsAbortMessage
    | WsApprovalPolicyMessage
    | WsRunStatusMessage
    | WsResumeMessage
    | WsDetachMessage
    | WsSyncMessage
    | WsCancelQueuedMessage;

/** Inbound message envelope */
export interface WsEnvelope {
    eventId?: number;
    eventCursor?: string;
    /** 用户级事件序号（per-user，user/dual/admin scope），用于 gap 检测和主动 sync */
    seq?: number;
    data: unknown;
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const CONNECT_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 50_000;

class WsClient {
    private ws: WebSocket | null = null;
    private state: WsState = 'disconnected';
    private messageHandlers = new Set<WsMessageHandler>();
    private stateHandlers = new Set<WsStateHandler>();
    private retryAttempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalClose = false;
    private connectPromiseResolve: (() => void) | null = null;
    private connectPromiseReject: ((err: Error) => void) | null = null;
    private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    // M20-04 boundary fence. Every disconnect/boundary invalidates old socket callbacks.
    private boundaryGeneration = 0;
    private sendingFrozen = false;

    // Reference counting (for mobile multi-screen)
    private refCount = 0;

    // Heartbeat
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private lastPongAt = 0;
    private lastPingSentAt = 0;

    // Per-connection authoritative recovery cursor. It is intentionally process-memory only.
    private recovery: SyncRecoveryState = createSyncRecoveryState();
    private sentSyncRequestId: number | null = null;
    private syncSessionId: string | null = null;

    private get lastSeq(): number { return this.recovery.lastSeq; }
    private get serverEpoch(): string | null { return this.recovery.serverEpoch; }

    // Auth failure detection
    private consecutiveFailures = 0;
    private onAuthFailureFn: (() => void) | null = null;

    private assertTrustedWsUrl(url: string): void {
        getPlatform().platformConfig.assertTrustedUrl?.(url, 'websocket');
    }

    /** Resolve endpoint and credential separately so JWT never enters URLs/logs. */
    private async getConnectionParams(): Promise<{ url: string; token?: string }> {
        const platform = getPlatform();
        const url = platform.platformConfig.getWsUrl();
        this.assertTrustedWsUrl(url);
        const authEnabled = await platform.platformConfig.isAuthEnabled?.() ?? true;
        if (!authEnabled) return { url };
        const token = await platform.secureStorage.getItem(TOKEN_KEY);
        if (!token) throw new Error('Missing authentication token');
        return { url, token };
    }

    /** Reference-counted connect. Returns a release function. */
    async acquire(): Promise<() => void> {
        this.refCount++;
        if (this.refCount === 1) {
            await this.connect();
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.release();
        };
    }

    private release(): void {
        this.refCount = Math.max(0, this.refCount - 1);
        if (this.refCount === 0) {
            this.disconnect();
        }
    }

    /** Force reconnect (app resume / network recovery). */
    async forceReconnect(): Promise<void> {
        this.stopHeartbeat();
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (this.connectTimeoutTimer) { clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
        this.connectPromiseResolve = null;
        this.connectPromiseReject = null;

        // 解绑旧 WS 防止 onclose 竞态
        const oldWs = this.ws;
        this.ws = null;
        if (oldWs) {
            oldWs.onclose = null;
            oldWs.onerror = null;
            oldWs.onopen = null;
            oldWs.onmessage = null;
            oldWs.close(1000, 'Force reconnect');
        }

        this.retryAttempt = 0;
        await this.connect();
    }

    /** Register auth failure callback (e.g. trigger logout) */
    setOnAuthFailure(fn: (() => void) | null): void {
        this.onAuthFailureFn = fn;
    }

    /** Establish connection */
    async connect(): Promise<void> {
        if (this.sendingFrozen) throw new Error('Identity boundary in progress');
        // Already connected
        if (this.ws?.readyState === WebSocket.OPEN && this.state === 'connected') {
            return;
        }
        // Currently connecting - reuse the same promise
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
            return new Promise<void>((resolve, reject) => {
                const prevResolve = this.connectPromiseResolve;
                const prevReject = this.connectPromiseReject;
                this.connectPromiseResolve = () => { prevResolve?.(); resolve(); };
                this.connectPromiseReject = (err) => { prevReject?.(err); reject(err); };
            });
        }

        // Cancel any pending retry to prevent duplicate connections
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }

        this.intentionalClose = false;

        const connectPromise = new Promise<void>((resolve, reject) => {
            this.connectPromiseResolve = resolve;
            this.connectPromiseReject = reject;
        });

        // Timeout guard: reject if connection doesn't establish within 60s
        this.connectTimeoutTimer = setTimeout(() => {
            this.connectTimeoutTimer = null;
            const reject = this.connectPromiseReject;
            this.connectPromiseResolve = null;
            this.connectPromiseReject = null;
            reject?.(new Error('Connection timeout'));
        }, CONNECT_TIMEOUT_MS);

        try {
            const { url, token } = await this.getConnectionParams();
            this.doConnect(url, token);
        } catch {
            this.scheduleRetry();
        }

        return connectPromise;
    }

    private sendRecoveryRequestIfNeeded(): void {
        const request = this.recovery.syncRequest;
        if (!request || request.id === this.sentSyncRequestId) return;
        this.sentSyncRequestId = request.id;
        this.send({
            action: 'sync',
            lastSeq: request.lastSeq,
            ...(request.epoch ? { epoch: request.epoch } : {}),
            ...(this.syncSessionId ? { sessionId: this.syncSessionId } : {}),
        });
    }

    /** Returns the one normalized envelope adapters may project, or null for rejected/control frames. */
    private reduceInboundRecovery(envelope: WsEnvelope): WsEnvelope | null {
        const data = envelope.data as WsEvent | undefined;
        if (!data?.type) return envelope;

        if (data.type === 'pong') {
            this.recovery = reduceSyncRecovery(this.recovery, {
                type: 'pong', seq: data.seq, epoch: data.epoch,
            });
            this.sendRecoveryRequestIfNeeded();
            return null;
        }

        if (data.type === 'sync_ok') {
            this.recovery = reduceSyncRecovery(this.recovery, {
                type: 'sync_ok', seq: data.seq, epoch: data.epoch, events: data.events,
            });
            const accepted = this.recovery.appliedEvents;
            const normalized: WsEvent = {
                type: 'sync_ok',
                seq: this.recovery.lastSeq,
                ...(this.recovery.serverEpoch ? { epoch: this.recovery.serverEpoch } : {}),
                events: accepted.map(({ seq, event }) => ({ seq, event })),
            };
            this.sendRecoveryRequestIfNeeded();
            return { ...envelope, data: normalized };
        }

        if (data.type === 'sync_overflow') {
            this.recovery = reduceSyncRecovery(this.recovery, {
                type: 'sync_overflow', seq: data.seq, epoch: data.epoch,
            });
            return {
                ...envelope,
                data: {
                    ...data,
                    seq: this.recovery.lastSeq,
                    ...(this.recovery.serverEpoch ? { epoch: this.recovery.serverEpoch } : {}),
                },
            };
        }

        if (typeof envelope.seq === 'number') {
            // N-1 servers do not expose an epoch. Their first observed live event is the only
            // available baseline; epoch-aware servers establish it through pong/sync first.
            if (this.recovery.lastSeq === 0 && this.recovery.serverEpoch === null && this.recovery.phase === 'idle') {
                this.recovery = { ...this.recovery, lastSeq: Math.max(0, envelope.seq - 1) };
            }
            this.recovery = reduceSyncRecovery(this.recovery, {
                type: 'event',
                envelope: {
                    seq: envelope.seq,
                    ...(typeof (data as { epoch?: unknown }).epoch === 'string'
                        ? { epoch: (data as unknown as { epoch: string }).epoch }
                        : {}),
                    event: data,
                },
            });
            this.sendRecoveryRequestIfNeeded();
            const accepted = this.recovery.appliedEvents[0];
            if (!accepted) return null;
            return { ...envelope, seq: accepted.seq, data: accepted.event };
        }

        return envelope;
    }

    private doConnect(url: string, token?: string): void {
        if (this.sendingFrozen) return;
        const socketBoundaryGeneration = this.boundaryGeneration;
        const isCurrentBoundary = () => socketBoundaryGeneration === this.boundaryGeneration && !this.sendingFrozen;
        const isReconnect = this.retryAttempt > 0;
        this.setState(isReconnect ? 'reconnecting' : 'connecting');

        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            this.scheduleRetry();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            if (this.ws !== ws || !isCurrentBoundary()) return; // stale identity/connection
            // Re-check at the exact credential boundary in case policy changed while
            // the socket upgrade was in flight.
            try {
                this.assertTrustedWsUrl(url);
            } catch {
                ws.close(1008, 'Untrusted WebSocket origin');
                if (this.ws === ws) this.ws = null;
                this.setState('disconnected');
                this.connectPromiseReject?.(new Error('Untrusted WebSocket origin'));
                this.connectPromiseResolve = null;
                this.connectPromiseReject = null;
                if (this.connectTimeoutTimer) {
                    clearTimeout(this.connectTimeoutTimer);
                    this.connectTimeoutTimer = null;
                }
                return;
            }
            // Auth-enabled deployments require auth as the first client frame. In no-auth
            // mode the server sends auth_ok immediately, so the client must stay silent.
            if (token) ws.send(JSON.stringify({ action: 'auth', token }));
        };

        ws.onmessage = (event: MessageEvent) => {
            if (this.ws !== ws || !isCurrentBoundary()) return;
            try {
                const envelope = JSON.parse(event.data as string) as WsEnvelope;
                const now = Date.now();
                // Any inbound frame proves the WS path is alive. Do not depend on
                // a pong/sync frame specifically; streaming frames may arrive while
                // heartbeat replies are queued behind other downstream messages.
                this.lastPongAt = now;
                const messageData = envelope.data as { type?: string } | null | undefined;
                const msgType = messageData?.type;
                if (msgType === 'auth_ok') {
                    this.retryAttempt = 0;
                    this.consecutiveFailures = 0;
                    this.setState('connected');
                    if (this.connectTimeoutTimer) { clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
                    this.connectPromiseResolve?.();
                    this.connectPromiseResolve = null;
                    this.connectPromiseReject = null;
                    this.startHeartbeat();
                    return;
                }
                if (this.state !== 'connected') return;
                const normalized = this.reduceInboundRecovery(envelope);
                if (!normalized) return;
                if (msgType === 'sync_ok' || msgType === 'sync_overflow') {
                    const rttMs = this.lastPingSentAt > 0 ? now - this.lastPingSentAt : undefined;
                    if (typeof rttMs === 'number' && rttMs >= 3000) {
                        console.warn(`[WS] Heartbeat sync response slow: ${msgType} ${rttMs}ms`);
                    }
                }
                for (const handler of this.messageHandlers) handler(normalized);
            } catch {
                // ignore parse errors
            }
        };

        ws.onclose = (event: CloseEvent) => {
            if (!isCurrentBoundary()) return;
            // Only null this.ws if it still points to this instance —
            // a newer doConnect() may have already replaced it.
            if (this.ws === ws) {
                this.ws = null;
                this.stopHeartbeat();
                if (this.intentionalClose) {
                    this.setState('disconnected');
                    return;
                }
                console.warn(`[WS] Connection closed: code=${event.code} reason=${event.reason}`);
                this.scheduleRetry();
            }
            // else: this WS was already superseded — do nothing
        };

        ws.onerror = () => {
            // onclose will fire after onerror
        };
    }

    private scheduleRetry(): void {
        const delay = RETRY_DELAYS[Math.min(this.retryAttempt, RETRY_DELAYS.length - 1)];
        this.retryAttempt++;
        this.consecutiveFailures++;
        this.setState('reconnecting');

        // After 3 consecutive failures, check if it's an auth issue
        if (this.consecutiveFailures >= 3) {
            void this.checkAuthStatus();
        }

        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null;
            if (!this.intentionalClose && !this.sendingFrozen) {
                try {
                    const { url, token } = await this.getConnectionParams();
                    this.doConnect(url, token);
                } catch {
                    this.scheduleRetry();
                }
            }
        }, delay);
    }

    /** Probe /api/auth/me to distinguish auth failure from network issues */
    private async checkAuthStatus(): Promise<void> {
        try {
            const platform = getPlatform();
            const baseUrl = platform.platformConfig.getBaseUrl();
            const authUrl = `${baseUrl}/api/auth/me`;
            platform.platformConfig.assertTrustedUrl?.(authUrl, 'http');
            const authEnabled = await platform.platformConfig.isAuthEnabled?.() ?? true;
            if (!authEnabled) return;
            const token = await platform.secureStorage.getItem(TOKEN_KEY);
            if (!token) { this.triggerAuthFailure(); return; }
            const res = await fetch(authUrl, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (res.status === 401) this.triggerAuthFailure();
            // Non-401 = server reachable but not an auth issue, continue normal retry
        } catch {
            // Network unreachable, continue retry
        }
    }

    private triggerAuthFailure(): void {
        this.intentionalClose = true;
        this.stopHeartbeat();
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (this.connectTimeoutTimer) { clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
        this.setState('disconnected');
        this.connectPromiseReject?.(new Error('Auth failed'));
        this.connectPromiseResolve = null;
        this.connectPromiseReject = null;
        this.onAuthFailureFn?.();
    }

    // ── Heartbeat ──────────────────────────────────────

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.lastPongAt = Date.now();
        this.heartbeatTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const idleMs = Date.now() - this.lastPongAt;
            if (idleMs > HEARTBEAT_TIMEOUT_MS) {
                console.warn(`[WS] Heartbeat timeout after ${idleMs}ms`);
                this.ws.close(4000, 'Heartbeat timeout');
                return;
            }
            this.lastPingSentAt = Date.now();
            this.ws.send(JSON.stringify({
                action: 'ping',
                lastSeq: this.lastSeq,
                ...(this.serverEpoch ? { epoch: this.serverEpoch } : {}),
                clientTs: this.lastPingSentAt,
            }));
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // ── Public API ──────────────────────────────────────

    /** N-1 adapter compatibility; prefer resetRecovery at account/session boundaries. */
    setLastSeq(seq: number): void {
        this.recovery = { ...this.recovery, lastSeq: Math.max(0, seq) };
    }

    /** N-1 adapter compatibility. Epoch is not persisted across process restarts. */
    setEpoch(epoch: string | null): void {
        if (epoch === null && this.recovery.lastSeq === 0) {
            this.resetRecovery();
            return;
        }
        this.recovery = { ...this.recovery, serverEpoch: epoch };
    }

    /** Supplies the optional session used by overflow inline recovery. */
    setSyncSessionId(sessionId: string | null): void {
        this.syncSessionId = sessionId;
    }

    /** Explicit M20-04 boundary: clear volatile cursor/generation state without reconnecting. */
    resetRecovery(baseline: { lastSeq?: number; serverEpoch?: string | null; sessionId?: string | null } = {}): void {
        this.recovery = createSyncRecoveryState(baseline);
        this.sentSyncRequestId = null;
        if ('sessionId' in baseline) this.syncSessionId = baseline.sessionId ?? null;
    }

    getRecoveryCursor(): Readonly<{ lastSeq: number; serverEpoch: string | null }> {
        return { lastSeq: this.recovery.lastSeq, serverEpoch: this.recovery.serverEpoch };
    }

    /** Freeze all outbound work before an account/session boundary reset. */
    freezeSending(): void {
        this.sendingFrozen = true;
        this.boundaryGeneration++;
    }

    /** Install the new identity after all sensitive projections have been cleared. */
    unfreezeSending(): void {
        this.sendingFrozen = false;
    }

    get isSendingFrozen(): boolean { return this.sendingFrozen; }

    /** Disconnect */
    disconnect(): void {
        this.boundaryGeneration++;
        this.intentionalClose = true;
        this.stopHeartbeat();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.connectTimeoutTimer) {
            clearTimeout(this.connectTimeoutTimer);
            this.connectTimeoutTimer = null;
        }
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this.setState('disconnected');
        this.connectPromiseResolve?.();
        this.connectPromiseResolve = null;
        this.connectPromiseReject = null;
    }

    /** Send message, returns whether successful (and re-checks the connected socket origin). */
    send(msg: WsOutboundMessage): boolean {
        if (this.sendingFrozen) return false;
        if (this.state === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                const socketUrl = (this.ws as unknown as { url?: unknown }).url;
                if (typeof socketUrl !== 'string') throw new Error('WebSocket URL unavailable');
                this.assertTrustedWsUrl(socketUrl);
            } catch {
                console.warn('[WS] Refusing send to an untrusted origin');
                this.disconnect();
                return false;
            }
            // wsClient 持有从 sync/真实事件得到的最新 epoch，覆盖调用方可能滞后的副本。
            const outbound = msg.action === 'sync'
                ? {
                    ...msg,
                    ...(this.serverEpoch ? { epoch: this.serverEpoch } : {}),
                    ...((msg.sessionId ?? this.syncSessionId) ? { sessionId: msg.sessionId ?? this.syncSessionId! } : {}),
                }
                : msg;
            this.ws.send(JSON.stringify(outbound));
            return true;
        }
        console.warn('[WS] Cannot send: not connected');
        return false;
    }

    /** Ensure connected then send (for critical paths) */
    async ensureConnectedSend(msg: WsOutboundMessage): Promise<boolean> {
        if (!this.isConnected) {
            try { await this.connect(); } catch { return false; }
        }
        return this.send(msg);
    }

    /** Whether currently connected */
    get isConnected(): boolean {
        return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
    }

    /** Current connection state */
    get currentState(): WsState {
        return this.state;
    }

    /** Register message listener */
    onMessage(handler: WsMessageHandler): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    /** Register state change listener */
    onStateChange(handler: WsStateHandler): () => void {
        this.stateHandlers.add(handler);
        return () => this.stateHandlers.delete(handler);
    }

    private setState(newState: WsState): void {
        if (this.state === newState) return;
        this.state = newState;
        for (const handler of this.stateHandlers) {
            handler(newState);
        }
    }
}

/** Global singleton */
export const wsClient = new WsClient();

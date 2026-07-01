/**
 * WebSocket Client - platform-agnostic singleton WS connection manager
 *
 * Supports:
 * - JWT auth via query string
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

export type WsState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WsMessageHandler = (data: any) => void;
export type WsStateHandler = (state: WsState) => void;

/** Outbound message types */
export interface WsChatMessage {
    action: 'chat';
    /** 客户端生成的 UUID，贯穿全链路，用于 ACK / 拒绝 / 幂等 / 状态机绑定 */
    client_msg_id?: string;
    message: string;
    sessionId?: string;
    attachments?: Array<{
        originalName: string;
        savedPath: string;
        relativePath: string;
        size: number;
        mimeType: string;
        isImage: boolean;
    }>;
    model?: string;
    /** 内部管理员验收开关：选择工具执行后端。普通 UI 不暴露。 */
    executionTarget?: 'server-local' | 'server-container';
    approvalPolicy?: {
        autoApproveTools?: boolean;
        autoApproveRunShell?: boolean;
    };
    voiceFile?: {
        savedPath: string;
        relativePath: string;
        duration: number;
    };
}

export interface WsRespondMessage {
  action: 'respond';
  interactionId: string;
  sessionId?: string | null;
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
    };
}

export interface WsResumeMessage {
    action: 'resume';
    sessionId: string;
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
}

export type WsOutboundMessage =
    | WsChatMessage
    | WsRespondMessage
    | WsAbortMessage
    | WsApprovalPolicyMessage
    | WsRunStatusMessage
    | WsResumeMessage
    | WsDetachMessage
    | WsSyncMessage;

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

    // Reference counting (for mobile multi-screen)
    private refCount = 0;

    // Heartbeat
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private lastPongAt = 0;
    private lastPingSentAt = 0;

    // Heartbeat-piggyback sync: last known user event sequence number
    private lastSeq = 0;

    // Auth failure detection
    private consecutiveFailures = 0;
    private onAuthFailureFn: (() => void) | null = null;

    /** Get WS URL (async - reads token from secure storage) */
    private async getWsUrl(): Promise<string> {
        const token = await getPlatform().secureStorage.getItem(TOKEN_KEY);
        return getPlatform().platformConfig.getWsUrl(token);
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
        // Already connected
        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }
        // Currently connecting - reuse the same promise
        if (this.ws?.readyState === WebSocket.CONNECTING) {
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
            const url = await this.getWsUrl();
            this.doConnect(url);
        } catch {
            this.scheduleRetry();
        }

        return connectPromise;
    }

    private doConnect(url: string): void {
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
            if (this.ws !== ws) return; // stale — a newer connection has replaced us
            this.retryAttempt = 0;
            this.consecutiveFailures = 0;
            this.setState('connected');
            // Clear connect timeout
            if (this.connectTimeoutTimer) { clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
            this.connectPromiseResolve?.();
            this.connectPromiseResolve = null;
            this.connectPromiseReject = null;
            // Start heartbeat
            this.startHeartbeat();
        };

        ws.onmessage = (event: MessageEvent) => {
            try {
                const envelope = JSON.parse(event.data as string) as WsEnvelope;
                const msgType = envelope.data && (envelope.data as { type?: string }).type;
                // Handle pong internally (don't forward to messageHandlers)
                if (msgType === 'pong') {
                    const now = Date.now();
                    const rttMs = this.lastPingSentAt > 0 ? now - this.lastPingSentAt : undefined;
                    this.lastPongAt = now;
                    // 心跳 piggyback sync：从 pong 中更新 lastSeq
                    const seq = (envelope.data as Record<string, unknown>).seq;
                    if (typeof seq === 'number') this.lastSeq = seq;
                    if (typeof rttMs === 'number' && rttMs >= 3000) {
                        console.warn(`[WS] Heartbeat pong slow: ${rttMs}ms`);
                    }
                    return;
                }
                // sync_ok / sync_overflow 可能来自心跳 piggyback——视为有效心跳响应，
                // 但不拦截，让其流入 messageHandlers 复用现有 sync 处理逻辑
                if (msgType === 'sync_ok' || msgType === 'sync_overflow') {
                    const now = Date.now();
                    const rttMs = this.lastPingSentAt > 0 ? now - this.lastPingSentAt : undefined;
                    this.lastPongAt = now;
                    if (typeof rttMs === 'number' && rttMs >= 3000) {
                        console.warn(`[WS] Heartbeat sync response slow: ${msgType} ${rttMs}ms`);
                    }
                }
                // 从任何携带 seq 的事件中自动更新 lastSeq（供心跳 piggyback sync 使用）
                if (typeof envelope.seq === 'number' && envelope.seq > this.lastSeq) {
                    this.lastSeq = envelope.seq;
                }
                for (const handler of this.messageHandlers) {
                    handler(envelope);
                }
            } catch {
                // ignore parse errors
            }
        };

        ws.onclose = (event: CloseEvent) => {
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
            if (!this.intentionalClose) {
                try {
                    const url = await this.getWsUrl();
                    this.doConnect(url);
                } catch {
                    this.scheduleRetry();
                }
            }
        }, delay);
    }

    /** Probe /api/auth/me to distinguish auth failure from network issues */
    private async checkAuthStatus(): Promise<void> {
        try {
            const token = await getPlatform().secureStorage.getItem(TOKEN_KEY);
            if (!token) { this.triggerAuthFailure(); return; }
            const baseUrl = getPlatform().platformConfig.getBaseUrl();
            const res = await fetch(`${baseUrl}/api/auth/me`, {
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
            this.ws.send(JSON.stringify({ action: 'ping', lastSeq: this.lastSeq, clientTs: this.lastPingSentAt }));
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // ── Public API ──────────────────────────────────────

    /** Update the last known user event sequence (called by useChatAppState after sync responses) */
    setLastSeq(seq: number): void {
        this.lastSeq = seq;
    }

    /** Disconnect */
    disconnect(): void {
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

    /** Send message, returns whether successful */
    send(msg: WsOutboundMessage): boolean {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
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
        return this.ws?.readyState === WebSocket.OPEN;
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

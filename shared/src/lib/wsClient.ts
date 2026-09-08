/**
 * Platform-agnostic authenticated WebSocket transport.
 * A connection is single-flight even while native SecureStore is being read.
 * Replacing a socket must never abandon callers waiting to send a message.
 */
import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';
import { AUTH_SESSION_KEY, type AuthSessionBinding } from './authLifecycle';
import type { SandboxProfile } from '../types/session';
import type { WsEvent } from '../types/ws';
import { createSyncRecoveryState, reduceSyncRecovery, type SyncRecoveryState } from './syncRecovery';
import type { CanonicalChatSubmissionWireMessage, ChatClientCapability } from './chatSubmission';

export type WsState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WsMessageHandler = (data: any) => void;
export type WsStateHandler = (state: WsState) => void;

interface WsChatControlFields {
    /** Internal administrator acceptance option; not exposed by ordinary UI. */
    executionTarget?: 'server-local' | 'server-container';
    approvalPolicy?: {
        autoApproveTools?: boolean;
        autoApproveRunShell?: boolean;
        lowRiskOnly?: boolean;
    };
}

/** ID-authoritative canonical submission; client-local paths are not representable. */
export type CanonicalWsChatMessage = CanonicalChatSubmissionWireMessage & WsChatControlFields;
/** @deprecated N-1 compatibility only. */
export interface LegacyWsChatAttachment {
    attachmentId?: string;
    originalName: string;
    /** @deprecated Never authoritative. */
    savedPath?: string;
    /** @deprecated Never authoritative. */
    relativePath: string;
    size: number;
    mimeType: string;
    isImage: boolean;
}
/** @deprecated New clients must use CanonicalWsChatMessage. */
export interface LegacyWsChatMessage extends WsChatControlFields {
    action: 'chat';
    deliveryMode?: 'queue' | 'steer';
    clientCapabilities?: ChatClientCapability[];
    client_msg_id?: string;
    message: string;
    sessionId?: string;
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
    approvalPolicy?: { autoApproveTools?: boolean; autoApproveRunShell?: boolean; lowRiskOnly?: boolean };
}
export interface WsResumeMessage {
    action: 'resume';
    sessionId: string;
    requestId?: string;
    networkGeneration?: number;
    lastEventId: number;
    lastEventCursor?: string | null;
    skipReplay?: boolean;
}
export interface WsRunStatusMessage { action: 'run_status'; runId: string }
export interface WsQueueSnapshotMessage {
    action: 'queue_snapshot';
    sessionId: string;
    requestId: string;
    networkGeneration: number;
}
export interface WsAttachActiveStreamMessage extends Omit<WsResumeMessage, 'action'> {
    action: 'attach_active_stream';
}
export interface WsDetachMessage { action: 'detach' }
export interface WsSyncMessage {
    action: 'sync';
    lastSeq: number;
    requestId?: string;
    networkGeneration?: number;
    epoch?: string;
    sessionId?: string;
}
export interface WsCancelQueuedMessage { action: 'cancel_queued'; sourceRunId: string }
export type WsOutboundMessage = WsChatMessage | WsRespondMessage | WsAbortMessage
    | WsApprovalPolicyMessage | WsRunStatusMessage | WsResumeMessage | WsQueueSnapshotMessage
    | WsAttachActiveStreamMessage | WsDetachMessage | WsSyncMessage | WsCancelQueuedMessage;
export interface WsEnvelope {
    authEpoch?: number;
    generation?: number;
    networkGeneration?: number;
    eventId?: number;
    eventCursor?: string;
    seq?: number;
    data: unknown;
}

interface PendingConnection {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
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
    private pendingConnection: PendingConnection | null = null;
    private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    /** Network attempts and identity boundaries are separate: reconnect may retain waiters, logout may not. */
    private socketAttempt = 0;
    private boundaryGeneration = 0;
    private sendingFrozen = false;
    private lifecycleSuspended = false;
    private activeAuthBinding: AuthSessionBinding | null = null;
    private refCount = 0;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private lastPongAt = 0;
    private lastPingSentAt = 0;
    private recovery: SyncRecoveryState = createSyncRecoveryState();
    private sentSyncRequestId: number | null = null;
    private syncSessionId: string | null = null;
    private consecutiveFailures = 0;
    private onAuthFailureFn: (() => void) | null = null;
    private get lastSeq(): number { return this.recovery.lastSeq; }
    private get serverEpoch(): string | null { return this.recovery.serverEpoch; }

    private assertTrustedWsUrl(url: string): void {
        getPlatform().platformConfig.assertTrustedUrl?.(url, 'websocket');
    }

    /** Credential and endpoint remain separate; JWTs never enter URLs or diagnostic logs. */
    private async getConnectionParams(): Promise<{ url: string; token?: string; binding?: AuthSessionBinding }> {
        const platform = getPlatform();
        const url = platform.platformConfig.getWsUrl();
        this.assertTrustedWsUrl(url);
        const authEnabled = await platform.platformConfig.isAuthEnabled?.() ?? true;
        if (!authEnabled) return { url };
        const token = await platform.secureStorage.getItem(TOKEN_KEY);
        if (!token) throw new Error('Missing authentication token');
        const rawBinding = await platform.secureStorage.getItem(AUTH_SESSION_KEY);
        if (!rawBinding) throw new Error('Missing authentication epoch');
        let binding: AuthSessionBinding;
        try { binding = JSON.parse(rawBinding) as AuthSessionBinding; }
        catch { throw new Error('Invalid authentication epoch'); }
        if (!Number.isSafeInteger(binding.authEpoch) || binding.authEpoch < 1
            || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
            throw new Error('Invalid authentication epoch');
        }
        return { url, token, binding };
    }

    async acquire(): Promise<() => void> {
        this.refCount++;
        try { await this.connect(); }
        catch (error) { this.release(); throw error; }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.release();
        };
    }
    private release(): void {
        this.refCount = Math.max(0, this.refCount - 1);
        if (this.refCount === 0) this.disconnect();
    }

    /** Retain the pending promise AND its original deadline when native lifecycle replaces a socket. */
    forceReconnect(): Promise<void> {
        if (this.sendingFrozen) return Promise.reject(new Error('Identity boundary in progress'));
        if (this.lifecycleSuspended) return Promise.reject(new Error('Lifecycle transport suspended'));
        this.stopHeartbeat();
        this.clearRetry();
        this.closeSocket('Force reconnect');
        this.retryAttempt = 0;
        if (this.pendingConnection) {
            this.startSocketAttempt();
            return this.pendingConnection.promise;
        }
        return this.connect();
    }

    setOnAuthFailure(fn: (() => void) | null): void { this.onAuthFailureFn = fn; }

    /** Install the single flight BEFORE the first asynchronous SecureStore read. */
    connect(): Promise<void> {
        if (this.sendingFrozen) return Promise.reject(new Error('Identity boundary in progress'));
        if (this.lifecycleSuspended) return Promise.reject(new Error('Lifecycle transport suspended'));
        if (this.isConnected) return Promise.resolve();
        if (this.pendingConnection) return this.pendingConnection.promise;
        this.clearRetry();
        this.intentionalClose = false;
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        const pending = { promise, resolve, reject };
        this.pendingConnection = pending;
        this.connectTimeoutTimer = setTimeout(() => {
            if (this.pendingConnection !== pending) return;
            this.clearRetry();
            this.stopHeartbeat();
            this.closeSocket('Connection timeout', 4000);
            this.settleConnection(new Error('Connection timeout'));
            this.setState('disconnected');
            if (this.refCount > 0) this.scheduleRetry();
        }, CONNECT_TIMEOUT_MS);
        this.startSocketAttempt();
        return promise;
    }

    private settleConnection(error?: Error): void {
        if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
        this.connectTimeoutTimer = null;
        const pending = this.pendingConnection;
        this.pendingConnection = null;
        if (error) pending?.reject(error);
        else pending?.resolve();
    }

    private startSocketAttempt(): void {
        const attempt = ++this.socketAttempt;
        const boundary = this.boundaryGeneration;
        const current = () => attempt === this.socketAttempt && boundary === this.boundaryGeneration
            && !this.intentionalClose && !this.sendingFrozen && !this.lifecycleSuspended;
        this.setState(this.retryAttempt > 0 ? 'reconnecting' : 'connecting');
        void this.getConnectionParams().then(({ url, token, binding }) => {
            if (!current()) return; // a delayed native credential read cannot resurrect an old account/socket
            this.doConnect(url, token, binding, attempt, boundary);
        }).catch(() => { if (current()) this.scheduleRetry(); });
    }

    private closeSocket(reason: string, code = 1000): void {
        this.socketAttempt++;
        const old = this.ws;
        this.ws = null;
        this.activeAuthBinding = null;
        if (!old) return;
        old.onopen = null;
        old.onmessage = null;
        old.onclose = null;
        old.onerror = null;
        try { old.close(code, reason); } catch { /* native transport may already be gone */ }
    }

    private sendRecoveryRequestIfNeeded(): void {
        const request = this.recovery.syncRequest;
        if (!request || request.id === this.sentSyncRequestId) return;
        this.sentSyncRequestId = request.id;
        this.send({ action: 'sync', lastSeq: request.lastSeq,
            ...(request.epoch ? { epoch: request.epoch } : {}),
            ...(this.syncSessionId ? { sessionId: this.syncSessionId } : {}),
        });
    }

    /** Preserve the shared epoch/sequence reducer; receipt delivery never bypasses identity fences. */
    private reduceInboundRecovery(envelope: WsEnvelope): WsEnvelope | null {
        const data = envelope.data as WsEvent | undefined;
        if (!data?.type) return envelope;
        if (data.type === 'pong') {
            this.recovery = reduceSyncRecovery(this.recovery, { type: 'pong', seq: data.seq, epoch: data.epoch });
            this.sendRecoveryRequestIfNeeded();
            return null;
        }
        if (data.type === 'sync_ok') {
            this.recovery = reduceSyncRecovery(this.recovery, {
                type: 'sync_ok', seq: data.seq, epoch: data.epoch, events: data.events,
            });
            const normalized: WsEvent = {
                type: 'sync_ok', seq: this.recovery.lastSeq,
                ...(this.recovery.serverEpoch ? { epoch: this.recovery.serverEpoch } : {}),
                events: this.recovery.appliedEvents.map(({ seq, event }) => ({ seq, event })),
                ...('requestId' in data && typeof data.requestId === 'string' ? { requestId: data.requestId } : {}),
                ...('networkGeneration' in data && typeof data.networkGeneration === 'number' ? { networkGeneration: data.networkGeneration } : {}),
            };
            this.sendRecoveryRequestIfNeeded();
            return { ...envelope, data: normalized };
        }
        if (data.type === 'sync_overflow') {
            this.recovery = reduceSyncRecovery(this.recovery, { type: 'sync_overflow', seq: data.seq, epoch: data.epoch });
            return { ...envelope, data: { ...data, seq: this.recovery.lastSeq,
                ...(this.recovery.serverEpoch ? { epoch: this.recovery.serverEpoch } : {}),
            } };
        }
        if (typeof envelope.seq === 'number') {
            if (this.recovery.lastSeq === 0 && this.recovery.serverEpoch === null && this.recovery.phase === 'idle') {
                this.recovery = { ...this.recovery, lastSeq: Math.max(0, envelope.seq - 1) };
            }
            this.recovery = reduceSyncRecovery(this.recovery, {
                type: 'event', envelope: { seq: envelope.seq,
                    ...(typeof (data as { epoch?: unknown }).epoch === 'string'
                        ? { epoch: (data as unknown as { epoch: string }).epoch } : {}),
                    event: data,
                },
            });
            this.sendRecoveryRequestIfNeeded();
            const accepted = this.recovery.appliedEvents[0];
            return accepted ? { ...envelope, seq: accepted.seq, data: accepted.event } : null;
        }
        return envelope;
    }

    private doConnect(url: string, token: string | undefined, binding: AuthSessionBinding | undefined,
        attempt: number, boundary: number): void {
        let ws: WebSocket;
        try { ws = new WebSocket(url); }
        catch { this.scheduleRetry(); return; }
        this.ws = ws;
        this.activeAuthBinding = binding ?? null;
        const current = () => this.ws === ws && attempt === this.socketAttempt
            && boundary === this.boundaryGeneration && !this.sendingFrozen;
        ws.onopen = () => {
            if (!current()) return;
            try { this.assertTrustedWsUrl(url); }
            catch { this.disconnect(); return; }
            try {
                // In no-auth mode the server sends auth_ok first; otherwise auth is the first client frame.
                if (token) ws.send(JSON.stringify({ action: 'auth', token, ...binding }));
            } catch { this.handleTransportFailure(ws); }
        };
        ws.onmessage = (event: MessageEvent) => {
            if (!current()) return;
            let envelope: WsEnvelope;
            try {
                const wire = JSON.parse(event.data as string) as WsEnvelope;
                if (!wire || typeof wire !== 'object' || !wire.data || typeof wire.data !== 'object') return;
                if (this.activeAuthBinding && (wire.authEpoch !== this.activeAuthBinding.authEpoch
                    || wire.generation !== this.activeAuthBinding.generation)) return;
                const { authEpoch: _authEpoch, generation: _generation, ...unbound } = wire;
                envelope = unbound;
            } catch { return; }
            this.lastPongAt = Date.now();
            const type = (envelope.data as { type?: string }).type;
            if (type === 'auth_ok') {
                this.retryAttempt = 0;
                this.consecutiveFailures = 0;
                this.settleConnection();
                this.setState('connected');
                if (current()) this.startHeartbeat();
                return;
            }
            if (this.state !== 'connected') return;
            let normalized: WsEnvelope | null;
            try { normalized = this.reduceInboundRecovery(envelope); }
            catch { console.warn('[WS] Invalid recovery frame'); return; }
            if (!normalized) return;
            // One screen/telemetry subscriber must not swallow ACKs for every other screen.
            for (const handler of [...this.messageHandlers]) {
                if (!current()) break;
                try { handler(normalized); }
                catch { console.warn('[WS] Message subscriber failed'); }
            }
        };
        ws.onclose = (event: CloseEvent) => {
            if (!current()) return;
            this.ws = null;
            this.stopHeartbeat();
            if (this.intentionalClose) { this.setState('disconnected'); return; }
            console.warn(`[WS] Connection closed: code=${event.code}`);
            this.scheduleRetry();
        };
        ws.onerror = () => { /* native/browser implementations emit close next */ };
    }

    private handleTransportFailure(ws: WebSocket): void {
        if (this.ws !== ws) return;
        this.stopHeartbeat();
        this.closeSocket('Transport send failed', 4000);
        this.scheduleRetry();
    }
    private clearRetry(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }
    private scheduleRetry(): void {
        if (this.intentionalClose || this.sendingFrozen || this.lifecycleSuspended || this.retryTimer) return;
        const delay = RETRY_DELAYS[Math.min(this.retryAttempt, RETRY_DELAYS.length - 1)];
        this.retryAttempt++;
        this.consecutiveFailures++;
        this.setState('reconnecting');
        if (this.consecutiveFailures >= 3) void this.checkAuthStatus();
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.intentionalClose || this.sendingFrozen || this.lifecycleSuspended) return;
            if (this.pendingConnection) this.startSocketAttempt();
            else void this.connect().catch(() => {});
        }, delay);
    }

    private async checkAuthStatus(): Promise<void> {
        const boundary = this.boundaryGeneration;
        try {
            const platform = getPlatform();
            const authUrl = `${platform.platformConfig.getBaseUrl()}/api/auth/me`;
            platform.platformConfig.assertTrustedUrl?.(authUrl, 'http');
            if (!(await platform.platformConfig.isAuthEnabled?.() ?? true)) return;
            const token = await platform.secureStorage.getItem(TOKEN_KEY);
            if (boundary !== this.boundaryGeneration || this.sendingFrozen) return;
            if (!token) { this.triggerAuthFailure(); return; }
            const res = await fetch(authUrl, { headers: { Authorization: `Bearer ${token}` } });
            // A late 401 from the previous login must not sign the new account out.
            if (res.status === 401 && boundary === this.boundaryGeneration
                && token === await platform.secureStorage.getItem(TOKEN_KEY)
                && boundary === this.boundaryGeneration && !this.sendingFrozen) this.triggerAuthFailure();
        } catch { /* network failure is not evidence of invalid authentication */ }
    }
    private triggerAuthFailure(): void {
        this.intentionalClose = true;
        this.stopHeartbeat();
        this.clearRetry();
        this.closeSocket('Auth failed', 4401);
        this.settleConnection(new Error('Auth failed'));
        this.setState('disconnected');
        this.onAuthFailureFn?.();
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        if (this.lifecycleSuspended || this.sendingFrozen) return;
        this.lastPongAt = Date.now();
        this.heartbeatTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
                try { ws.close(4000, 'Heartbeat timeout'); }
                catch { this.handleTransportFailure(ws); }
                return;
            }
            this.lastPingSentAt = Date.now();
            try {
                ws.send(JSON.stringify({ action: 'ping', lastSeq: this.lastSeq,
                    ...(this.serverEpoch ? { epoch: this.serverEpoch } : {}),
                    clientTs: this.lastPingSentAt, ...(this.activeAuthBinding ?? {}),
                }));
            } catch { this.handleTransportFailure(ws); }
        }, HEARTBEAT_INTERVAL_MS);
    }
    private stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    setLastSeq(seq: number): void { this.recovery = { ...this.recovery, lastSeq: Math.max(0, seq) }; }
    setEpoch(epoch: string | null): void {
        if (epoch === null && this.recovery.lastSeq === 0) { this.resetRecovery(); return; }
        this.recovery = { ...this.recovery, serverEpoch: epoch };
    }
    setSyncSessionId(sessionId: string | null): void { this.syncSessionId = sessionId; }
    resetRecovery(baseline: { lastSeq?: number; serverEpoch?: string | null; sessionId?: string | null } = {}): void {
        this.recovery = createSyncRecoveryState(baseline);
        this.sentSyncRequestId = null;
        if ('sessionId' in baseline) this.syncSessionId = baseline.sessionId ?? null;
    }
    getRecoveryCursor(): Readonly<{ lastSeq: number; serverEpoch: string | null }> {
        return { lastSeq: this.recovery.lastSeq, serverEpoch: this.recovery.serverEpoch };
    }
    freezeSending(): void { this.sendingFrozen = true; this.boundaryGeneration++; }
    unfreezeSending(): void { this.sendingFrozen = false; }
    get isSendingFrozen(): boolean { return this.sendingFrozen; }
    suspendNonEssentialTransport(): void {
        this.lifecycleSuspended = true;
        this.stopHeartbeat();
        this.clearRetry();
    }
    resumeNonEssentialTransport(): void {
        this.lifecycleSuspended = false;
        if (this.isConnected) this.startHeartbeat();
    }
    get isLifecycleSuspended(): boolean { return this.lifecycleSuspended; }

    disconnect(): void {
        this.boundaryGeneration++;
        this.intentionalClose = true;
        this.stopHeartbeat();
        this.clearRetry();
        this.closeSocket('Client disconnect');
        this.setState('disconnected');
        // Keep the historical connect() cancellation contract. ensureConnectedSend fences this resolution.
        this.settleConnection();
    }

    /** true only means written to transport, not accepted by the server. No automatic chat resubmission. */
    send(msg: WsOutboundMessage): boolean {
        if (this.sendingFrozen || this.lifecycleSuspended) return false;
        const ws = this.ws;
        if (this.state !== 'connected' || !ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            const socketUrl = (ws as unknown as { url?: unknown }).url;
            if (typeof socketUrl !== 'string') throw new Error('WebSocket URL unavailable');
            this.assertTrustedWsUrl(socketUrl);
        } catch { console.warn('[WS] Refusing send to an untrusted origin'); this.disconnect(); return false; }
        const outbound = msg.action === 'sync' ? {
            ...msg,
            ...(this.serverEpoch ? { epoch: this.serverEpoch } : {}),
            ...((msg.sessionId ?? this.syncSessionId) ? { sessionId: msg.sessionId ?? this.syncSessionId! } : {}),
        } : msg;
        try { ws.send(JSON.stringify({ ...outbound, ...(this.activeAuthBinding ?? {}) })); return true; }
        catch { this.handleTransportFailure(ws); return false; }
    }
    async ensureConnectedSend(msg: WsOutboundMessage): Promise<boolean> {
        const boundary = this.boundaryGeneration;
        if (!this.isConnected) {
            try { await this.connect(); } catch { return false; }
        }
        if (boundary !== this.boundaryGeneration) return false;
        return this.send(msg);
    }
    get isConnected(): boolean { return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN; }
    get currentState(): WsState { return this.state; }
    onMessage(handler: WsMessageHandler): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }
    onStateChange(handler: WsStateHandler): () => void {
        this.stateHandlers.add(handler);
        return () => this.stateHandlers.delete(handler);
    }
    private setState(newState: WsState): void {
        if (this.state === newState) return;
        this.state = newState;
        for (const handler of [...this.stateHandlers]) {
            try { handler(newState); }
            catch { console.warn('[WS] State subscriber failed'); }
        }
    }
}
export const wsClient = new WsClient();

import type { IncomingMessage, Server as HttpServer } from 'http';
import { randomUUID } from 'node:crypto';
import { URL } from 'url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientDaemonConnection, ClientDaemonTransport } from './clientDaemonTransport.js';
import {
  deriveClientDaemonHandId,
  parseClientDaemonMessage,
  serializeClientDaemonMessage,
  type ClientDaemonMessage,
} from './clientDaemonProtocol.js';
import type { ToolInvocationRequest, ToolInvocationResponse, ToolInvocationStream, ToolInvocationStreamChunk } from './handProtocol.js';
import type { HandStore } from './handStore.js';
import { verifyClientDaemonBearer, type ClientDaemonRegistry } from './clientDaemonRegistry.js';
import type { SecretVault } from '../security/secretVault.js';

export interface ClientDaemonGatewayOptions {
  transport: ClientDaemonTransport;
  handStore?: HandStore;
  path?: string;
  authToken?: string;
  /**
   * C1: Per-device capability registry. When present, the gateway tries
   * (daemonId, bearer) against `registry.get + vault.getSecret` first; legacy
   * shared `authToken` is checked only as a fallback when no device record
   * matches. This lets ops rotate / revoke a single device without touching
   * the gateway process.
   */
  deviceRegistry?: ClientDaemonRegistry;
  /** Required when deviceRegistry is set — backing SecretVault for per-device bearers. */
  deviceSecretVault?: SecretVault;
  helloTimeoutMs?: number;
  /** 单个 daemon 连接 lastSeenAt 未刷新超过该值视为失联；0 关闭扫描。默认 60s。 */
  heartbeatTimeoutMs?: number;
  /** scanner 周期。默认 timeout/3，最小 1s。 */
  heartbeatScanIntervalMs?: number;
  /**
   * C2: grace period after a daemon socket drops before pending invocations
   * are failed. When the same handId reconnects within this window the
   * pendingInvokes Map (stream queues) is transferred to the new socket so
   * upstream callers don't see the drop. Set to 0 (default for backward
   * compatibility) to keep the previous immediate-failAll behavior.
   */
  disconnectGracePeriodMs?: number;
  logger?: { info?(message: string): void; warn?(message: string, error?: unknown): void; error?(message: string, error?: unknown): void };
}

interface PendingInvoke {
  invocationId: string;
  queue: AsyncChunkQueue;
}

interface PendingCancel {
  invocationId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class AsyncChunkQueue {
  private readonly chunks: ToolInvocationStreamChunk[] = [];
  private readonly waiters: Array<(result: IteratorResult<ToolInvocationStreamChunk>) => void> = [];
  private closed = false;
  private error: Error | undefined;

  push(chunk: ToolInvocationStreamChunk): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else this.chunks.push(chunk);
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.error = error;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
  }

  async *iterate(): ToolInvocationStream {
    while (true) {
      if (this.chunks.length > 0) {
        yield this.chunks.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.error) throw this.error;
        return;
      }
      const result = await new Promise<IteratorResult<ToolInvocationStreamChunk>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}

class WebSocketClientDaemonConnection implements ClientDaemonConnection {
  readonly handId: string;
  readonly daemonId: string;
  capabilities: ClientDaemonConnection['capabilities'];
  /**
   * C3: opaque tag the daemon assigns to its capability set. When a reconnect
   * presents the same handId AND the same version, the gateway keeps the
   * cached capabilities verbatim and skips re-registering them.
   */
  capabilitiesVersion?: string;
  lastSeenAt: string;
  lastSeenAtMs: number;
  /** scanner 关闭连接前可写入，作为 hand metadata patch / 日志的失联原因。 */
  disconnectReason?: string;
  /**
   * C2: pendingInvokes survive socket churn — when the daemon reconnects
   * within the grace window the gateway calls `rebindSocket(newWs)` and the
   * same map continues receiving chunks from the new socket.
   */
  readonly pendingInvokes = new Map<string, PendingInvoke>();
  private readonly pendingCancels = new Map<string, PendingCancel>();
  private ws: WebSocket;

  constructor(
    ws: WebSocket,
    private readonly gateway: ClientDaemonGateway,
    hello: Extract<ClientDaemonMessage, { type: 'daemon_hello' }>,
  ) {
    this.ws = ws;
    this.handId = hello.handId ?? deriveClientDaemonHandId(hello.daemonId);
    this.daemonId = hello.daemonId;
    this.capabilities = hello.capabilities;
    this.capabilitiesVersion = hello.capabilitiesVersion;
    const now = Date.now();
    this.lastSeenAt = new Date(now).toISOString();
    this.lastSeenAtMs = now;
  }

  /**
   * C2: switch the underlying ws after a grace-period reconnect. pendingInvokes
   * keep their queues so the new socket can deliver invoke_chunk frames into
   * the same readers without the caller seeing the drop.
   */
  rebindSocket(ws: WebSocket): void {
    this.ws = ws;
    const now = Date.now();
    this.lastSeenAt = new Date(now).toISOString();
    this.lastSeenAtMs = now;
    this.disconnectReason = undefined;
  }

  async invoke(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    let final: ToolInvocationResponse | undefined;
    for await (const chunk of this.invokeStream(request)) {
      if (chunk.type === 'completed') final = chunk.response;
    }
    return final ?? { status: 'error', error: 'client daemon invocation ended without response' };
  }

  invokeStream(request: ToolInvocationRequest): ToolInvocationStream {
    return this.invokeStreamInternal(request);
  }

  async cancel(invocationId: string): Promise<void> {
    if (this.ws.readyState !== this.ws.OPEN) return;
    const requestId = this.nextRequestId('cancel');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCancels.delete(requestId);
        reject(new Error(`client daemon cancel timed out: ${invocationId}`));
      }, 5_000);
      timer.unref?.();
      this.pendingCancels.set(requestId, { invocationId, resolve, reject, timer });
      this.send({ type: 'cancel_request', protocolVersion: 1, requestId, invocationId, reason: 'cancel_requested' });
    }).catch(() => {
      this.gateway.logWarn('Client daemon cancel delivery failed');
    });
  }

  async close(): Promise<void> {
    this.ws.close();
    this.failAll(new Error('client daemon connection closed'));
  }

  handleMessage(message: ClientDaemonMessage): void {
    const now = Date.now();
    this.lastSeenAt = new Date(now).toISOString();
    this.lastSeenAtMs = now;
    if (message.type === 'daemon_heartbeat') return;
    if (message.type === 'invoke_chunk') {
      const pending = this.pendingInvokes.get(message.requestId);
      if (!pending) return;
      if (pending.invocationId !== message.invocationId) {
        pending.queue.fail(new Error('client daemon response invocationId mismatch'));
        this.pendingInvokes.delete(message.requestId);
        return;
      }
      pending.queue.push(message.chunk);
      if (message.chunk.type === 'completed') {
        pending.queue.close();
        this.pendingInvokes.delete(message.requestId);
      }
      return;
    }
    if (message.type === 'invoke_completed') {
      const pending = this.pendingInvokes.get(message.requestId);
      if (!pending) return;
      if (pending.invocationId !== message.invocationId) {
        pending.queue.fail(new Error('client daemon response invocationId mismatch'));
        this.pendingInvokes.delete(message.requestId);
        return;
      }
      pending.queue.push({ type: 'completed', response: message.response });
      pending.queue.close();
      this.pendingInvokes.delete(message.requestId);
      return;
    }
    if (message.type === 'cancel_ack') {
      const pending = this.pendingCancels.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingCancels.delete(message.requestId);
      if (pending.invocationId !== message.invocationId) {
        pending.reject(new Error('client daemon cancel invocationId mismatch'));
      } else {
        message.accepted ? pending.resolve() : pending.reject(new Error('client daemon rejected cancel'));
      }
      return;
    }
    if (message.type === 'daemon_error') {
      if (message.requestId) {
        const error = new Error('client daemon reported an error');
        const invoke = this.pendingInvokes.get(message.requestId);
        if (invoke) {
          invoke.queue.fail(message.invocationId && message.invocationId !== invoke.invocationId
            ? new Error('client daemon response invocationId mismatch')
            : error);
        }
        const cancel = this.pendingCancels.get(message.requestId);
        if (cancel) {
          clearTimeout(cancel.timer);
          this.pendingCancels.delete(message.requestId);
          cancel.reject(message.invocationId && message.invocationId !== cancel.invocationId
            ? new Error('client daemon cancel invocationId mismatch')
            : error);
        }
      }
    }
  }

  failAll(error: Error): void {
    for (const pending of this.pendingInvokes.values()) pending.queue.fail(error);
    this.pendingInvokes.clear();
    for (const [requestId, pending] of this.pendingCancels) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingCancels.delete(requestId);
    }
  }

  private async *invokeStreamInternal(request: ToolInvocationRequest): ToolInvocationStream {
    if (this.ws.readyState !== this.ws.OPEN) {
      yield { type: 'completed', response: { status: 'error', error: `client daemon hand not connected: ${this.handId}` } };
      return;
    }
    const invocationId = request.context.invocationId
      ?? request.context.correlation?.invocationId
      ?? this.nextRequestId('invocation');
    const requestId = this.nextRequestId('invoke');
    const queue = new AsyncChunkQueue();
    this.pendingInvokes.set(requestId, { invocationId, queue });
    try {
      this.send({ type: 'invoke_request', protocolVersion: 1, requestId, invocationId, request });
      yield* queue.iterate();
    } finally {
      this.pendingInvokes.delete(requestId);
    }
  }

  private send(message: ClientDaemonMessage): void {
    this.ws.send(serializeClientDaemonMessage(message));
  }

  private nextRequestId(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }
}

export class ClientDaemonGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly path: string;
  private readonly helloTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatScanIntervalMs: number;
  private readonly activeConnections = new Map<string, { ws: WebSocket; connection: WebSocketClientDaemonConnection }>();
  private readonly latestSockets = new Map<string, WebSocket>();
  /**
   * C2: handId → grace-period entry kept across a socket drop. Holds the
   * orphaned connection (with its pending stream queues) until the daemon
   * reconnects or the grace timer expires.
   */
  private readonly gracefulDisconnects = new Map<string, {
    connection: WebSocketClientDaemonConnection;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private heartbeatScanner: ReturnType<typeof setInterval> | undefined;
  private attached = false;
  private readonly disconnectGracePeriodMs: number;
  /**
   * A5: mutable so vault rotation can hot-replace the accepted token without a
   * gateway restart. Already-established daemon sockets keep working — rotation
   * only protects new connections. Existing sessions are dropped only when the
   * daemon itself reconnects (which is the natural rotation handshake).
   */
  private authToken?: string;

  constructor(private readonly options: ClientDaemonGatewayOptions) {
    this.path = options.path ?? '/daemon';
    this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    const defaultScan = Math.max(1_000, Math.floor(this.heartbeatTimeoutMs / 3));
    this.heartbeatScanIntervalMs = options.heartbeatScanIntervalMs ?? defaultScan;
    this.authToken = options.authToken;
    this.disconnectGracePeriodMs = options.disconnectGracePeriodMs ?? 0;
  }

  /**
   * A5: hot-rotate the shared bearer token. Subsequent connection attempts must
   * present the new token; pass `undefined` to disable auth entirely (dev only).
   * Existing established connections are left intact — daemon clients reconnect
   * normally as their local cached token rotates.
   */
  setAuthToken(token: string | undefined): void {
    this.authToken = token;
  }

  attach(httpServer: HttpServer): void {
    if (this.attached) return;
    this.attached = true;
    httpServer.on('upgrade', (request, socket, head) => {
      if (this.parsePathname(request) !== this.path) return;
      // C1: per-device bearer is only known after the daemon_hello message;
      // when a device registry is configured the upgrade lets the socket
      // through and per-device check happens inside handleConnection. Without
      // a registry the upgrade still enforces the legacy shared bearer.
      if (!this.authenticateUpgrade(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });
    this.wss.on('connection', (ws, request) => this.handleConnection(ws, request));
    this.startHeartbeatScanner();
  }

  close(): void {
    if (this.heartbeatScanner) {
      clearInterval(this.heartbeatScanner);
      this.heartbeatScanner = undefined;
    }
    this.wss.close();
  }

  logWarn(message: string, error?: unknown): void {
    this.options.logger?.warn?.(message, error);
  }

  /** 暴露给测试：手动触发一次扫描，避免依赖 setInterval 真实时序。 */
  scanHeartbeatsOnce(now: number = Date.now()): void {
    if (this.heartbeatTimeoutMs <= 0) return;
    for (const [handId, entry] of this.activeConnections) {
      const idleMs = now - entry.connection.lastSeenAtMs;
      if (idleMs <= this.heartbeatTimeoutMs) continue;
      const reason = `heartbeat_timeout:${idleMs}ms`;
      entry.connection.disconnectReason = reason;
      this.options.logger?.warn?.(`Client daemon heartbeat timeout: handId=${handId} idleMs=${idleMs}`);
      try {
        // Send a close frame so cooperative peers can clean up gracefully...
        entry.ws.close(1011, 'heartbeat timeout');
        // ...but a frozen / unresponsive peer will never ACK; ws.close() then waits for the
        // closing handshake (or TCP timeout, which can be minutes). Force the underlying
        // socket destruction so ws.on('close') fires immediately and the unhealthy path runs.
        entry.ws.terminate();
      } catch {
        this.options.logger?.warn?.('Client daemon force close failed');
      }
    }
  }

  private startHeartbeatScanner(): void {
    if (this.heartbeatScanner || this.heartbeatTimeoutMs <= 0) return;
    this.heartbeatScanner = setInterval(() => this.scanHeartbeatsOnce(), this.heartbeatScanIntervalMs);
    this.heartbeatScanner.unref?.();
  }

  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const helloTimer = setTimeout(() => {
      ws.close(1008, 'daemon hello timeout');
    }, this.helloTimeoutMs);
    helloTimer.unref?.();
    let connection: WebSocketClientDaemonConnection | undefined;

    ws.once('message', async (raw) => {
      clearTimeout(helloTimer);
      try {
        const hello = parseClientDaemonMessage(raw.toString());
        if (hello.type !== 'daemon_hello') throw new Error('first client daemon message must be daemon_hello');
        if (!(await this.authenticateHello(request, hello))) throw new Error('invalid client daemon auth token');
        const provisionalHandId = hello.handId ?? deriveClientDaemonHandId(hello.daemonId);
        // C2: check graceful-disconnect cache first. Same handId reconnecting
        // within the grace window means we can revive the prior connection
        // object — its pendingInvokes / pendingCancels maps are still alive
        // and upstream callers haven't been failed yet.
        const grace = this.gracefulDisconnects.get(provisionalHandId);
        const resumedInvocationIds = new Set(
          (hello.resumeInvocations ?? []).map((item) => item.invocationId),
        );
        const canResumeGrace = grace
          && [...grace.connection.pendingInvokes.values()]
            .every((pending) => resumedInvocationIds.has(pending.invocationId));
        if (grace && canResumeGrace) {
          clearTimeout(grace.timer);
          this.gracefulDisconnects.delete(provisionalHandId);
          connection = grace.connection;
          connection.rebindSocket(ws);
          // C3 capability resync: skip the capabilities rewrite when both
          // sides have a non-empty version tag that matches. Brand new
          // version OR missing-on-either-side → trust the incoming list.
          const cachedVersion = connection.capabilitiesVersion;
          const incomingVersion = hello.capabilitiesVersion;
          const versionMatches = !!cachedVersion && !!incomingVersion && cachedVersion === incomingVersion;
          if (!versionMatches) {
            connection.capabilities = hello.capabilities;
            connection.capabilitiesVersion = incomingVersion;
          }
          this.latestSockets.set(connection.handId, ws);
          this.activeConnections.set(connection.handId, { ws, connection });
          this.options.transport.register(connection);
          const reconnectMetadata = {
            reconnectedAt: new Date().toISOString(),
            disconnectReason: null,
            ...(versionMatches ? { capabilityResync: 'skipped_same_version' } : { capabilityResync: 'updated' }),
            ...(incomingVersion ? { capabilitiesVersion: incomingVersion } : {}),
          };
          if (versionMatches) {
            await this.options.handStore?.updateStatus(connection.handId, 'ready', reconnectMetadata);
          } else if (this.options.handStore) {
            const existing = await this.options.handStore.get(connection.handId);
            await this.options.handStore.register({
              handId: connection.handId,
              sessionId: hello.sessionId ?? existing?.sessionId,
              workspaceId: hello.workspaceId ?? existing?.workspaceId ?? `client:${hello.daemonId}`,
              type: 'client',
              status: 'ready',
              endpoint: `daemon://${hello.daemonId}`,
              capabilities: connection.capabilities,
              metadata: { daemonId: hello.daemonId, ...reconnectMetadata },
            });
          }
          ws.send(serializeClientDaemonMessage({
            type: 'daemon_registered',
            protocolVersion: 1,
            daemonId: hello.daemonId,
            handId: connection.handId,
          }));
          this.options.logger?.info?.(
            `Client daemon reconnected within grace period: daemonId=${hello.daemonId} handId=${connection.handId} pendingInvokes=${connection.pendingInvokes.size} capabilityResync=${versionMatches ? 'skipped' : 'updated'}`,
          );
        } else {
          if (grace) {
            clearTimeout(grace.timer);
            this.gracefulDisconnects.delete(provisionalHandId);
            grace.connection.failAll(new Error('client daemon did not resume pending invocations'));
            this.options.logger?.info?.(`Client daemon grace resumption declined: handId=${provisionalHandId}`);
          }
          const replaced = this.activeConnections.get(provisionalHandId);
          connection = new WebSocketClientDaemonConnection(ws, this, hello);
          this.latestSockets.set(connection.handId, ws);
          this.activeConnections.set(connection.handId, { ws, connection });
          this.options.transport.register(connection);
          if (replaced && replaced.ws !== ws) {
            replaced.connection.failAll(new Error('client daemon connection replaced'));
            replaced.ws.close(1000, 'daemon connection replaced');
          }
          await this.options.handStore?.register({
            handId: connection.handId,
            sessionId: hello.sessionId,
            workspaceId: hello.workspaceId ?? `client:${hello.daemonId}`,
            type: 'client',
            status: 'ready',
            endpoint: `daemon://${hello.daemonId}`,
            capabilities: hello.capabilities,
            metadata: { daemonId: hello.daemonId, connectedAt: new Date().toISOString() },
          });
          ws.send(serializeClientDaemonMessage({
            type: 'daemon_registered',
            protocolVersion: 1,
            daemonId: hello.daemonId,
            handId: connection.handId,
          }));
          this.options.logger?.info?.(`Client daemon connected: daemonId=${hello.daemonId} handId=${connection.handId}`);
        }
      } catch {
        this.options.logger?.warn?.('Client daemon hello rejected');
        ws.close(1008, 'invalid daemon hello');
      }
    });

    ws.on('message', (raw) => {
      if (!connection) return;
      try {
        connection.handleMessage(parseClientDaemonMessage(raw.toString()));
      } catch {
        this.options.logger?.warn?.('Client daemon message rejected');
        ws.send(serializeClientDaemonMessage({
          type: 'daemon_error',
          protocolVersion: 1,
          message: 'invalid client daemon message',
        }));
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!connection) return;
      // A replacement or reconnected socket owns the latest generation. Keep
      // this tombstone-style map separate from activeConnections so a newer
      // socket that already entered grace cannot be overwritten by stale close.
      if (this.latestSockets.get(connection.handId) !== ws) return;
      this.latestSockets.delete(connection.handId);
      this.activeConnections.delete(connection.handId);
      this.options.transport.unregister(connection.handId);
      const reason = connection.disconnectReason ?? 'connection_closed';
      // C2: when grace period is enabled AND there are pending invokes worth
      // resuming, park the connection instead of failing them immediately.
      // Grace timer fires the real cleanup if no reconnect arrives in time.
      if (this.disconnectGracePeriodMs > 0 && connection.pendingInvokes.size > 0) {
        const orphanedConnection = connection;
        const timer = setTimeout(() => {
          this.gracefulDisconnects.delete(orphanedConnection.handId);
          orphanedConnection.failAll(new Error(`client daemon grace period elapsed: ${reason}`));
          void this.options.handStore?.updateStatus(orphanedConnection.handId, 'unhealthy', {
            disconnectedAt: new Date().toISOString(),
            disconnectReason: `grace_period_elapsed:${reason}`,
          });
          this.options.logger?.warn?.(`Client daemon grace period elapsed: handId=${orphanedConnection.handId}`);
        }, this.disconnectGracePeriodMs);
        timer.unref?.();
        this.gracefulDisconnects.set(connection.handId, { connection: orphanedConnection, timer });
        this.options.logger?.info?.(`Client daemon entering grace period: handId=${connection.handId} pendingInvokes=${connection.pendingInvokes.size} gracePeriodMs=${this.disconnectGracePeriodMs}`);
        return;
      }
      connection.failAll(new Error(`client daemon connection closed: ${reason}`));
      void this.options.handStore?.updateStatus(connection.handId, 'unhealthy', {
        disconnectedAt: new Date().toISOString(),
        disconnectReason: reason,
      });
      this.options.logger?.info?.(`Client daemon disconnected: handId=${connection.handId} reason=${reason}`);
    });
  }

  /**
   * Upgrade-time auth: at HTTP upgrade we don't yet know which device is
   * connecting (the hello message hasn't arrived). Two policies:
   *   - registry configured → let the socket through; per-device check runs
   *     inside handleConnection() against (hello.daemonId, hello.authToken).
   *   - no registry → enforce the legacy shared bearer here.
   */
  private authenticateUpgrade(request: IncomingMessage): boolean {
    if (this.options.deviceRegistry) return true;
    const expected = this.authToken;
    if (!expected) return true;
    return this.presentedBearer(request) === expected;
  }

  /**
   * Hello-time auth: device-aware path used after the daemon_hello message
   * arrives. Tries per-device first when registry+vault are configured; falls
   * back to the shared bearer for backward compat with daemons that don't
   * declare a device identity yet.
   */
  private async authenticateHello(request: IncomingMessage, hello: { daemonId: string; authToken?: string }): Promise<boolean> {
    const presented = hello.authToken ?? this.presentedBearer(request);
    if (this.options.deviceRegistry && this.options.deviceSecretVault) {
      try {
        const ok = await verifyClientDaemonBearer({
          registry: this.options.deviceRegistry,
          vault: this.options.deviceSecretVault,
          deviceId: hello.daemonId,
          bearer: presented ?? '',
        });
        if (ok) return true;
        // fall through to shared-bearer fallback only when there's no record at
        // all; an explicit disabled / mismatched record must NOT silently fall
        // back to the shared token (that would defeat per-device revocation).
        const record = await this.options.deviceRegistry.get(hello.daemonId);
        if (record) return false;
      } catch {
        this.options.logger?.warn?.('Client daemon device auth lookup failed');
        return false;
      }
    }
    const expected = this.authToken;
    if (!expected) return true;
    return presented === expected;
  }

  private presentedBearer(request: IncomingMessage): string | undefined {
    const urlToken = this.parseUrl(request)?.searchParams.get('token') ?? undefined;
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined;
    return urlToken ?? bearer;
  }

  private parsePathname(request: IncomingMessage): string | undefined {
    return this.parseUrl(request)?.pathname;
  }

  private parseUrl(request: IncomingMessage): URL | undefined {
    try {
      return new URL(request.url ?? '/', 'http://localhost');
    } catch {
      return undefined;
    }
  }
}

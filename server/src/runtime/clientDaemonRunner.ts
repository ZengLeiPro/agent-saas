import { setTimeout as delay } from 'timers/promises';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import {
  ServerLocalExecutionProvider,
  WORKSPACE_HAND_TOOLS,
  type ExecutionProvider,
} from '../agent/toolRuntime.js';
import type { HandCapability } from './handStore.js';
import type { ToolInvocationRequest } from './handProtocol.js';
import {
  parseClientDaemonMessage,
  serializeClientDaemonMessage,
  type ClientDaemonMessage,
} from './clientDaemonProtocol.js';

export interface ClientDaemonRunnerOptions {
  url: string;
  daemonId: string;
  workspaceRoot: string;
  authToken?: string;
  handId?: string;
  sessionId?: string;
  workspaceId?: string;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  provider?: ExecutionProvider;
  logger?: {
    info?(message: string): void;
    warn?(message: string, error?: unknown): void;
    error?(message: string, error?: unknown): void;
  };
}

interface ActiveInvocation {
  controller: AbortController;
}

export class ClientDaemonRunner {
  private readonly provider: ExecutionProvider;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly activeInvocations = new Map<string, ActiveInvocation>();
  private stopped = false;
  private ws: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: ClientDaemonRunnerOptions) {
    this.provider = options.provider ?? new ServerLocalExecutionProvider();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (err) {
        if (this.stopped) break;
        this.options.logger?.warn?.(`client daemon connection ended: ${err instanceof Error ? err.message : String(err)}`, err);
      }
      if (!this.stopped) await delay(this.reconnectDelayMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopHeartbeat();
    for (const [invocationId, active] of this.activeInvocations) {
      active.controller.abort(`daemon stopping: ${invocationId}`);
    }
    this.activeInvocations.clear();
    await new Promise<void>((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', () => resolve());
      ws.close();
      setTimeout(resolve, 1_000).unref?.();
    });
  }

  private async connectOnce(): Promise<void> {
    const ws = new WebSocket(this.withAuthToken(this.options.url));
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const caps = this.capabilities();
    this.send(ws, {
      type: 'daemon_hello',
      protocolVersion: 1,
      daemonId: this.options.daemonId,
      ...(this.options.handId ? { handId: this.options.handId } : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      workspaceId: this.options.workspaceId ?? this.options.daemonId,
      ...(this.options.authToken ? { authToken: this.options.authToken } : {}),
      capabilities: caps,
      // C3 capability resync — content hash of the capability set. Gateway can
      // skip rewriting HandStore on reconnect when this matches the cached
      // version (i.e. the daemon's tool surface hasn't actually changed).
      capabilitiesVersion: hashCapabilities(caps),
    });

    this.startHeartbeat(ws);
    this.options.logger?.info?.(`client daemon connected to ${this.options.url}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('message', (raw) => {
        void this.handleMessage(ws, raw.toString()).catch((err) => {
          this.options.logger?.warn?.(`client daemon message failed: ${err instanceof Error ? err.message : String(err)}`, err);
        });
      });
      ws.once('close', () => {
        this.stopHeartbeat();
        this.failActiveInvocations('client daemon websocket closed');
        resolve();
      });
      ws.once('error', (err) => {
        this.stopHeartbeat();
        this.failActiveInvocations(`client daemon websocket error: ${err.message}`);
        reject(err);
      });
    });
  }

  private capabilities(): HandCapability[] {
    return [{
      name: 'workspace',
      description: 'Customer-side workspace daemon capable of filesystem and shell execution inside its configured workspace root.',
      tools: WORKSPACE_HAND_TOOLS,
      constraints: [
        'Paths are resolved inside the daemon workspace root.',
        'Shell is executed on the customer-side daemon host and supports streaming/cancel.',
      ],
      risk: 'dangerous',
    }];
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    const message = parseClientDaemonMessage(raw);
    switch (message.type) {
      case 'daemon_registered':
        this.options.logger?.info?.(`client daemon registered as hand ${message.handId}`);
        return;
      case 'invoke_request':
        await this.handleInvoke(ws, message);
        return;
      case 'cancel_request':
        this.handleCancel(ws, message);
        return;
      case 'daemon_error':
        this.options.logger?.warn?.(`platform daemon_error: ${message.message}`);
        return;
      default:
        return;
    }
  }

  private async handleInvoke(ws: WebSocket, message: Extract<ClientDaemonMessage, { type: 'invoke_request' }>): Promise<void> {
    const controller = new AbortController();
    this.activeInvocations.set(message.invocationId, { controller });
    const request = this.withDaemonWorkspace(message.request, message.invocationId, controller.signal);
    let sawCompleted = false;
    try {
      if (this.provider.executeStream) {
        for await (const chunk of this.provider.executeStream(request)) {
          if (chunk.type === 'completed') {
            sawCompleted = true;
            this.send(ws, {
              type: 'invoke_completed',
              protocolVersion: 1,
              requestId: message.requestId,
              invocationId: message.invocationId,
              response: chunk.response,
            });
          } else {
            this.send(ws, {
              type: 'invoke_chunk',
              protocolVersion: 1,
              requestId: message.requestId,
              invocationId: message.invocationId,
              chunk,
            });
          }
        }
      } else {
        const response = await this.provider.execute(request);
        sawCompleted = true;
        this.send(ws, {
          type: 'invoke_completed',
          protocolVersion: 1,
          requestId: message.requestId,
          invocationId: message.invocationId,
          response,
        });
      }
      if (!sawCompleted) {
        this.send(ws, {
          type: 'invoke_completed',
          protocolVersion: 1,
          requestId: message.requestId,
          invocationId: message.invocationId,
          response: { status: 'error', error: 'client daemon provider stream ended without completed chunk' },
        });
      }
    } catch (err) {
      this.send(ws, {
        type: 'invoke_completed',
        protocolVersion: 1,
        requestId: message.requestId,
        invocationId: message.invocationId,
        response: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      this.activeInvocations.delete(message.invocationId);
    }
  }

  private handleCancel(ws: WebSocket, message: Extract<ClientDaemonMessage, { type: 'cancel_request' }>): void {
    const active = this.activeInvocations.get(message.invocationId);
    active?.controller.abort(message.reason ?? 'cancel_requested');
    this.send(ws, {
      type: 'cancel_ack',
      protocolVersion: 1,
      requestId: message.requestId,
      invocationId: message.invocationId,
      accepted: Boolean(active),
      message: active ? undefined : 'invocation not running',
    });
  }

  private withDaemonWorkspace(request: ToolInvocationRequest, invocationId: string, signal: AbortSignal): ToolInvocationRequest {
    return {
      ...request,
      context: {
        ...request.context,
        invocationId,
        signal,
        workspace: {
          ...request.context.workspace,
          id: this.options.workspaceId ?? request.context.workspace.id ?? this.options.daemonId,
          root: this.options.workspaceRoot,
          executionTarget: 'client',
        },
      },
    };
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.send(ws, {
        type: 'daemon_heartbeat',
        protocolVersion: 1,
        daemonId: this.options.daemonId,
        handId: this.options.handId ?? `client-${this.options.daemonId}`,
        activeInvocationIds: [...this.activeInvocations.keys()],
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private failActiveInvocations(reason: string): void {
    for (const active of this.activeInvocations.values()) active.controller.abort(reason);
    this.activeInvocations.clear();
  }

  private withAuthToken(rawUrl: string): string {
    if (!this.options.authToken) return rawUrl;
    const parsed = new URL(rawUrl);
    if (!parsed.searchParams.has('token')) parsed.searchParams.set('token', this.options.authToken);
    return parsed.toString();
  }

  private send(ws: WebSocket, message: ClientDaemonMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(serializeClientDaemonMessage(message));
  }
}

/**
 * C3: deterministic content hash of a capability set. Only the (name, version-
 * forming) fields the gateway needs to detect "same tool surface" — tool ids
 * + names + risks — are folded in; descriptive prose (descriptions /
 * constraints) is omitted so harmless wording tweaks don't bust the cache.
 */
export function hashCapabilities(capabilities: HandCapability[]): string {
  const canon = capabilities.map((cap) => ({
    name: cap.name,
    risk: cap.risk,
    tools: [...cap.tools]
      .map((t) => ({ id: t.id, name: t.name, risk: t.risk, approvalMode: t.approvalMode }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 32);
}

import type { ToolInvocationRequest, ToolInvocationResponse, ToolInvocationStreamChunk } from './handProtocol.js';
import type { HandCapability } from './handStore.js';

export type ClientDaemonProtocolVersion = 1;

export type ClientDaemonMessage =
  | {
    type: 'daemon_hello';
    protocolVersion: ClientDaemonProtocolVersion;
    daemonId: string;
    handId?: string;
    sessionId?: string;
    workspaceId?: string;
    authToken?: string;
    /**
     * Hand capabilities. May be empty on a reconnect when the daemon sends
     * `capabilitiesVersion` and the gateway already holds an identical version
     * (C3 capability resync). On a fresh connect this must be the full list.
     */
    capabilities: HandCapability[];
    /**
     * C3: opaque content hash / monotonic tag of the capabilities the daemon
     * intends to register. When the gateway has a cached connection with the
     * same handId+version it can keep the cached capabilities verbatim and
     * skip rewriting HandStore — saves the round-trip cost of redundant
     * registration on every reconnect.
     */
    capabilitiesVersion?: string;
    /**
     * C2: invocations the daemon was running before the previous socket dropped.
     * Forward-compatible — gateway tolerates absence (legacy behavior) and uses
     * the list, when present, to decide whether grace-period buffered pending
     * stream queues can be migrated to the new connection.
     */
    resumeInvocations?: Array<{ invocationId: string }>;
  }
  | {
    type: 'daemon_registered';
    protocolVersion: ClientDaemonProtocolVersion;
    daemonId: string;
    handId: string;
  }
  | {
    type: 'daemon_heartbeat';
    protocolVersion: ClientDaemonProtocolVersion;
    daemonId: string;
    handId: string;
    activeInvocationIds?: string[];
  }
  | {
    type: 'invoke_request';
    protocolVersion: ClientDaemonProtocolVersion;
    requestId: string;
    invocationId: string;
    request: ToolInvocationRequest;
  }
  | {
    type: 'invoke_chunk';
    protocolVersion: ClientDaemonProtocolVersion;
    requestId: string;
    invocationId: string;
    chunk: ToolInvocationStreamChunk;
  }
  | {
    type: 'invoke_completed';
    protocolVersion: ClientDaemonProtocolVersion;
    requestId: string;
    invocationId: string;
    response: ToolInvocationResponse;
  }
  | {
    type: 'cancel_request';
    protocolVersion: ClientDaemonProtocolVersion;
    requestId: string;
    invocationId: string;
    reason?: string;
  }
  | {
    type: 'cancel_ack';
    protocolVersion: ClientDaemonProtocolVersion;
    requestId: string;
    invocationId: string;
    accepted: boolean;
    message?: string;
  }
  | {
    type: 'daemon_error';
    protocolVersion: ClientDaemonProtocolVersion;
    requestId?: string;
    invocationId?: string;
    message: string;
  };

export function assertClientDaemonProtocolVersion(message: ClientDaemonMessage): void {
  if (message.protocolVersion !== 1) {
    throw new Error(`unsupported client daemon protocol version: ${message.protocolVersion}`);
  }
}

export function parseClientDaemonMessage(raw: string | Buffer | Uint8Array): ClientDaemonMessage {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  const parsed = JSON.parse(text) as Partial<ClientDaemonMessage>;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    throw new Error('invalid client daemon protocol message');
  }
  assertClientDaemonProtocolVersion(parsed as ClientDaemonMessage);
  assertClientDaemonMessageShape(parsed);
  return parsed as ClientDaemonMessage;
}

function assertClientDaemonMessageShape(message: Partial<ClientDaemonMessage>): void {
  switch (message.type) {
    case 'daemon_hello':
      requireString(message, 'daemonId');
      requireArray(message, 'capabilities');
      return;
    case 'daemon_registered':
      requireString(message, 'daemonId');
      requireString(message, 'handId');
      return;
    case 'daemon_heartbeat':
      requireString(message, 'daemonId');
      requireString(message, 'handId');
      return;
    case 'invoke_request':
      requireString(message, 'requestId');
      requireString(message, 'invocationId');
      requireObject(message, 'request');
      return;
    case 'invoke_chunk':
      requireString(message, 'requestId');
      requireString(message, 'invocationId');
      requireObject(message, 'chunk');
      return;
    case 'invoke_completed':
      requireString(message, 'requestId');
      requireString(message, 'invocationId');
      requireObject(message, 'response');
      return;
    case 'cancel_request':
    case 'cancel_ack':
      requireString(message, 'requestId');
      requireString(message, 'invocationId');
      return;
    case 'daemon_error':
      requireString(message, 'message');
      return;
    default:
      throw new Error(`unknown client daemon protocol message type: ${String(message.type)}`);
  }
}

function requireString(message: Record<string, unknown>, key: string): void {
  if (typeof message[key] !== 'string' || !message[key]) {
    throw new Error(`invalid client daemon protocol message: missing ${key}`);
  }
}

function requireObject(message: Record<string, unknown>, key: string): void {
  const value = message[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid client daemon protocol message: missing ${key}`);
  }
}

function requireArray(message: Record<string, unknown>, key: string): void {
  if (!Array.isArray(message[key])) {
    throw new Error(`invalid client daemon protocol message: missing ${key}`);
  }
}

export function serializeClientDaemonMessage(message: ClientDaemonMessage): string {
  assertClientDaemonProtocolVersion(message);
  return JSON.stringify(message);
}

import { createHash } from 'node:crypto';
import { CORRELATION_CONTEXT_VERSION, parseCorrelationContext } from '@agent/shared';

import type { ToolInvocationRequest, ToolInvocationResponse, ToolInvocationStreamChunk } from './handProtocol.js';
import type { HandCapability } from './handStore.js';

export type ClientDaemonProtocolVersion = 1;

const CLIENT_DAEMON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const MAX_CLIENT_DAEMON_ID_LENGTH = 256;
const MAX_CLIENT_DAEMON_ID_LIST_LENGTH = 4_096;
const MAX_CLIENT_DAEMON_CAPABILITIES = 64;
const MAX_CLIENT_DAEMON_TOOLS_PER_CAPABILITY = 512;
const MAX_CLIENT_DAEMON_CONSTRAINTS = 256;
const MAX_CLIENT_DAEMON_TEXT_LENGTH = 16_384;

export function deriveClientDaemonHandId(daemonId: string): string {
  const legacy = `client-${daemonId}`;
  return legacy.length <= MAX_CLIENT_DAEMON_ID_LENGTH
    ? legacy
    : `client-${createHash('sha256').update(daemonId).digest('hex')}`;
}

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
    throw new Error('unsupported client daemon protocol version');
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
      requireProtocolId(message, 'daemonId');
      requireOptionalProtocolId(message, 'handId');
      requireOptionalProtocolId(message, 'sessionId');
      requireOptionalProtocolId(message, 'workspaceId');
      requireOptionalProtocolId(message, 'capabilitiesVersion');
      requireOptionalString(message, 'authToken');
      requireOptionalInvocationList(message, 'resumeInvocations');
      requireCapabilities(message, 'capabilities');
      return;
    case 'daemon_registered':
      requireProtocolId(message, 'daemonId');
      requireProtocolId(message, 'handId');
      return;
    case 'daemon_heartbeat':
      requireProtocolId(message, 'daemonId');
      requireProtocolId(message, 'handId');
      requireOptionalProtocolIdArray(message, 'activeInvocationIds');
      return;
    case 'invoke_request':
      requireProtocolId(message, 'requestId');
      requireProtocolId(message, 'invocationId');
      requireObject(message, 'request');
      normalizeToolInvocationCorrelation(message.request, message.invocationId);
      return;
    case 'invoke_chunk':
      requireProtocolId(message, 'requestId');
      requireProtocolId(message, 'invocationId');
      requireInvocationChunk(message, 'chunk');
      return;
    case 'invoke_completed':
      requireProtocolId(message, 'requestId');
      requireProtocolId(message, 'invocationId');
      requireInvocationResponse(message, 'response');
      return;
    case 'cancel_request':
      requireProtocolId(message, 'requestId');
      requireProtocolId(message, 'invocationId');
      requireOptionalString(message, 'reason');
      return;
    case 'cancel_ack':
      requireProtocolId(message, 'requestId');
      requireProtocolId(message, 'invocationId');
      requireBoolean(message, 'accepted');
      requireOptionalString(message, 'message');
      return;
    case 'daemon_error':
      requireOptionalProtocolId(message, 'requestId');
      requireOptionalProtocolId(message, 'invocationId');
      requireString(message, 'message');
      return;
    default:
      throw new Error('unknown client daemon protocol message type');
  }
}

function requireString(message: Record<string, unknown>, key: string): void {
  if (typeof message[key] !== 'string'
    || !message[key]
    || message[key].length > MAX_CLIENT_DAEMON_TEXT_LENGTH) {
    throw new Error(`invalid client daemon protocol message: missing ${key}`);
  }
}

function requireOptionalString(message: Record<string, unknown>, key: string): void {
  const value = message[key];
  if (value !== undefined && (typeof value !== 'string' || value.length > MAX_CLIENT_DAEMON_TEXT_LENGTH)) {
    throw new Error(`invalid client daemon protocol string: ${key}`);
  }
}

function requireBoolean(message: Record<string, unknown>, key: string): void {
  if (typeof message[key] !== 'boolean') {
    throw new Error(`invalid client daemon protocol boolean: ${key}`);
  }
}

function requireProtocolId(message: Record<string, unknown>, key: string): void {
  if (typeof message[key] !== 'string' || !message[key]) {
    throw new Error(`invalid client daemon protocol message: missing ${key}`);
  }
  if (!CLIENT_DAEMON_ID_PATTERN.test(message[key])) {
    throw new Error(`invalid client daemon protocol identity: ${key}`);
  }
}

function requireOptionalProtocolId(message: Record<string, unknown>, key: string): void {
  if (message[key] !== undefined) requireProtocolId(message, key);
}

function requireOptionalProtocolIdArray(message: Record<string, unknown>, key: string): void {
  const value = message[key];
  if (value === undefined) return;
  if (!Array.isArray(value)
    || value.length > MAX_CLIENT_DAEMON_ID_LIST_LENGTH
    || value.some((item) => typeof item !== 'string' || !CLIENT_DAEMON_ID_PATTERN.test(item))) {
    throw new Error(`invalid client daemon protocol identity list: ${key}`);
  }
}

function requireOptionalInvocationList(message: Record<string, unknown>, key: string): void {
  const value = message[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_CLIENT_DAEMON_ID_LIST_LENGTH || value.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const invocationId = (item as Record<string, unknown>).invocationId;
    return typeof invocationId !== 'string' || !CLIENT_DAEMON_ID_PATTERN.test(invocationId);
  })) {
    throw new Error(`invalid client daemon protocol invocation list: ${key}`);
  }
}

function requireObject(message: Record<string, unknown>, key: string): void {
  const value = message[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid client daemon protocol message: missing ${key}`);
  }
}

function requireInvocationChunk(message: Record<string, unknown>, key: string): void {
  const value = message[key];
  if (!isRecord(value)) {
    throw new Error(`invalid client daemon protocol invocation chunk: ${key}`);
  }
  const valid = value.type === 'output'
    ? (value.channel === 'stdout' || value.channel === 'stderr') && typeof value.content === 'string'
    : value.type === 'progress'
      ? typeof value.message === 'string'
      : value.type === 'completed' && isInvocationResponse(value.response);
  if (!valid) throw new Error(`invalid client daemon protocol invocation chunk: ${key}`);
}

function requireInvocationResponse(message: Record<string, unknown>, key: string): void {
  if (!isInvocationResponse(message[key])) {
    throw new Error(`invalid client daemon protocol invocation response: ${key}`);
  }
}

function isInvocationResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const terminal = value.status === 'success'
    ? typeof value.content === 'string'
    : value.status === 'error' && typeof value.error === 'string';
  return terminal
    && (value.audit === undefined || Array.isArray(value.audit))
    && (value.metadata === undefined || isRecord(value.metadata));
}

function requireCapabilities(message: Record<string, unknown>, key: string): void {
  const value = message[key];
  if (!Array.isArray(value)
    || value.length > MAX_CLIENT_DAEMON_CAPABILITIES
    || value.some((capability) => !isValidCapability(capability))) {
    throw new Error(`invalid client daemon protocol capabilities: ${key}`);
  }
}

function isValidCapability(value: unknown): boolean {
  if (!isRecord(value)
    || !isBoundedString(value.name)
    || !isBoundedString(value.description, true)
    || !isRisk(value.risk)
    || !Array.isArray(value.constraints)
    || value.constraints.length > MAX_CLIENT_DAEMON_CONSTRAINTS
    || value.constraints.some((constraint) => !isBoundedString(constraint, true))
    || !Array.isArray(value.tools)
    || value.tools.length > MAX_CLIENT_DAEMON_TOOLS_PER_CAPABILITY) {
    return false;
  }
  return value.tools.every((tool) => isValidToolDescriptor(tool));
}

function isValidToolDescriptor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isBoundedString(value.id)
    && isBoundedString(value.name)
    && isBoundedString(value.displayName, true)
    && isBoundedString(value.description, true)
    && isBoundedString(value.auditCategory)
    && isRisk(value.risk)
    && (value.approvalMode === 'never' || value.approvalMode === 'web')
    && isRecord(value.schema)
    && (value.parametersJsonSchema === undefined || isRecord(value.parametersJsonSchema))
    && (value.concurrency === undefined || value.concurrency === 'parallel')
    && (value.category === undefined || isBoundedString(value.category));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= MAX_CLIENT_DAEMON_TEXT_LENGTH
    && (allowEmpty || value.length > 0);
}

function isRisk(value: unknown): boolean {
  return value === 'safe' || value === 'workspace_write' || value === 'dangerous';
}

export function serializeClientDaemonMessage(message: ClientDaemonMessage): string {
  assertClientDaemonProtocolVersion(message);
  return JSON.stringify(message);
}


function normalizeToolInvocationCorrelation(request: unknown, envelopeInvocationId: unknown): void {
  const context = request && typeof request === 'object'
    ? (request as { context?: unknown }).context
    : undefined;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('invalid client daemon protocol message: missing request.context');
  }
  const value = context as Record<string, unknown>;
  const invocationId = value.invocationId;
  const handId = value.handId;
  if (invocationId !== undefined && typeof invocationId !== 'string') {
    throw new Error('invalid client daemon correlation: context.invocationId 格式非法');
  }
  if (handId !== undefined && typeof handId !== 'string') {
    throw new Error('invalid client daemon correlation: context.handId 格式非法');
  }
  const parsed = parseCorrelationContext(value.correlation, { invocationId, handId });
  if (!parsed.ok) throw new Error(`invalid client daemon correlation: ${parsed.error}`);
  const requestInvocationId = parsed.value?.invocationId;
  if (typeof envelopeInvocationId === 'string'
    && requestInvocationId
    && envelopeInvocationId !== requestInvocationId) {
    throw new Error('invalid client daemon correlation: envelope invocationId 冲突');
  }
  value.correlation = {
    ...(parsed.value ?? { version: CORRELATION_CONTEXT_VERSION }),
    ...(typeof envelopeInvocationId === 'string' ? { invocationId: envelopeInvocationId } : {}),
  };
}

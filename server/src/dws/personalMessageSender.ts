import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { ExecutionTransport } from '../runtime/executionTransport.js';
import { HttpTransport, type HttpTransportOptions } from '../runtime/httpTransport.js';
import type { DwsWorkspacePrincipal } from './authFlow.js';
import { deriveDwsPrincipalWorkspaceId, resolveDwsPrincipalCwd } from './authFlow.js';
import { principalFor } from './agentAuthFlow.js';
import type { DwsPersonalEvent } from './personalEventGateway.js';

const DWS_MESSAGE_TIMEOUT_MS = 60_000;
export const DWS_PERSONAL_MESSAGE_MAX_CHARACTERS = 12_000;
export const DWS_PERSONAL_MESSAGE_TRUNCATION_MARKER = '\n\n[消息已截断]';

export interface DwsPersonalMessageSenderOptions {
  agentCwd: string;
  resolveServerRemote: (principal: DwsWorkspacePrincipal) => Promise<{
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  }>;
  transportFactory?: (options: HttpTransportOptions) => Pick<ExecutionTransport, 'invoke'>;
  logger?: {
    info?(message: string): void;
    warn?(message: string): void;
  };
}

export interface DwsPersonalMessageSenderLike {
  send(
    account: AgentDwsAccountRecord,
    event: DwsPersonalEvent,
    text: string,
    idempotencyKey: string,
  ): Promise<void>;
}

/**
 * Sends a current-user DWS message from the Agent's isolated workspace.
 * The supplied idempotency key is passed unchanged to DWS as --uuid; DWS
 * provides the corresponding 24-hour message idempotency window.
 */
export class DwsPersonalMessageSender implements DwsPersonalMessageSenderLike {
  constructor(private readonly options: DwsPersonalMessageSenderOptions) {}

  async send(
    account: AgentDwsAccountRecord,
    event: DwsPersonalEvent,
    text: string,
    idempotencyKey: string,
  ): Promise<void> {
    // Build and validate before resolving credentials or touching the transport.
    const command = buildDwsPersonalMessageCommand(account, event, text, idempotencyKey);
    const principal = principalFor(account);
    const remote = await this.options.resolveServerRemote(principal);
    const transport = this.options.transportFactory
      ? this.options.transportFactory(remote)
      : new HttpTransport(remote);

    const root = resolveDwsPrincipalCwd(this.options.agentCwd, principal);
    const mountSubPath = deriveAgentWorkspaceMountSubPath(this.options.agentCwd, root);
    if (!mountSubPath) throw new Error('无法解析 Agent DWS connector workspace 挂载路径');
    const workspaceId = deriveDwsPrincipalWorkspaceId(principal);

    const response = await transport.invoke({
      toolName: 'Shell',
      input: { command, timeoutMs: DWS_MESSAGE_TIMEOUT_MS },
      context: {
        invocationId: `agent-dws-message-${randomUUID()}`,
        workspace: {
          id: workspaceId,
          root,
          userId: account.accountId,
          username: account.displayName,
          tenantId: account.tenantId,
          sessionId: `agent-dws-message-${account.accountId}`,
          sandboxScopeId: `${workspaceId}__dws_messages`,
          mountSubPath,
          executionTarget: 'server-remote',
        },
      },
    });

    if (response.status === 'error') {
      const error = redactDwsMessageError(response.error, remote.authToken);
      this.options.logger?.warn?.(
        `Agent DWS message send failed account=${account.accountId} event=${event.eventId}: ${error}`,
      );
      // A failed reply is deliberately not retried as send: doing so can double-deliver.
      throw new Error(`Agent DWS 消息发送失败：${error}`);
    }

    this.options.logger?.info?.(
      `Agent DWS message sent account=${account.accountId} event=${event.eventId}`,
    );
  }
}

/** Pure command builder: validates all required fields and quotes every dynamic argument. */
export function buildDwsPersonalMessageCommand(
  account: AgentDwsAccountRecord,
  event: DwsPersonalEvent,
  text: string,
  idempotencyKey: string,
): string {
  const profileId = requiredText(account.profileId, 'Agent DWS profile 缺失');
  const uuid = requiredText(idempotencyKey, 'Agent DWS 消息幂等键缺失');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Agent DWS 消息正文缺失');
  const safeText = truncateDwsPersonalMessageText(text);

  const conversationId = optionalText(event.conversationId);
  const messageId = optionalText(event.messageId);
  const senderOpenDingtalkId = optionalText(event.senderOpenDingtalkId);
  const commonArgs = `--text ${shellQuote(safeText)} --uuid ${shellQuote(uuid)} --profile ${shellQuote(profileId)} --format json`;

  if (conversationId && messageId && senderOpenDingtalkId) {
    return `dws chat message reply --conversation-id ${shellQuote(conversationId)} --ref-msg-id ${shellQuote(messageId)} --ref-sender ${shellQuote(senderOpenDingtalkId)} ${commonArgs}`;
  }

  if (event.type === 'user_im_message_receive_at') {
    if (!conversationId) throw new Error('Agent DWS 群消息目标 conversationId 缺失');
    return `dws chat message send --group ${shellQuote(conversationId)} ${commonArgs}`;
  }

  if (event.type === 'user_im_message_receive_o2o_all') {
    if (!senderOpenDingtalkId) throw new Error('Agent DWS 单聊目标 senderOpenDingtalkId 缺失');
    return `dws chat message send --open-dingtalk-id ${shellQuote(senderOpenDingtalkId)} ${commonArgs}`;
  }

  throw new Error(`Agent DWS 消息缺少回复引用字段，且事件类型不支持发送：${safeErrorLabel(event.type)}`);
}

export function truncateDwsPersonalMessageText(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= DWS_PERSONAL_MESSAGE_MAX_CHARACTERS) return text;
  const marker = Array.from(DWS_PERSONAL_MESSAGE_TRUNCATION_MARKER);
  return characters
    .slice(0, DWS_PERSONAL_MESSAGE_MAX_CHARACTERS - marker.length)
    .concat(marker)
    .join('');
}

export function deriveAgentWorkspaceMountSubPath(agentCwd: string, workspaceRoot: string): string | undefined {
  const mountRoot = resolve(agentCwd, '..');
  const rel = relative(mountRoot, resolve(workspaceRoot));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function requiredText(value: unknown, message: string): string {
  const normalized = optionalText(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeErrorLabel(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100) || 'unknown';
}

function redactDwsMessageError(error: unknown, authToken: string): string {
  let message = error instanceof Error ? error.message : String(error ?? 'unknown_error');
  if (authToken) message = message.split(authToken).join('[REDACTED]');
  return message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}

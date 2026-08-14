import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import {
  buildDwsPersonalMessageCommand,
  DWS_PERSONAL_MESSAGE_MAX_CHARACTERS,
  DWS_PERSONAL_MESSAGE_TRUNCATION_MARKER,
  DwsPersonalMessageSender,
  truncateDwsPersonalMessageText,
} from '../dws/personalMessageSender.js';
import type { DwsPersonalEvent } from '../dws/personalEventGateway.js';
import type { ToolInvocationRequest, ToolInvocationResponse } from '../runtime/handProtocol.js';

const account: AgentDwsAccountRecord = {
  accountId: 'adws-1',
  tenantId: 'tenant-a',
  agentId: 'oa-sales',
  displayName: '销售数字员工',
  loginId: 'sales-agent-001',
  profileId: 'corp-a',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me', 'all_direct'],
  revision: 8,
  createdAt: '2026-08-13T00:00:00.000Z',
  createdBy: 'admin-a',
  updatedAt: '2026-08-13T00:00:00.000Z',
  updatedBy: 'admin-a',
};

function personalEvent(overrides: Partial<DwsPersonalEvent> = {}): DwsPersonalEvent {
  return {
    type: 'user_im_message_receive_at',
    eventId: 'event-1',
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderOpenDingtalkId: 'sender-1',
    raw: {},
    ...overrides,
  };
}

function successfulInvoke() {
  return vi.fn(async (_request: ToolInvocationRequest): Promise<ToolInvocationResponse> => ({
    status: 'success',
    content: '{"success":true}',
  }));
}

describe('DwsPersonalMessageSender command builder', () => {
  it('引用字段齐全时优先构建 reply，并透传 24h 幂等 uuid', () => {
    expect(buildDwsPersonalMessageCommand(account, personalEvent(), '已收到', 'event:event-1')).toBe(
      "dws chat message reply --conversation-id 'cid-1' --ref-msg-id 'msg-1' --ref-sender 'sender-1' --text '已收到' --uuid 'event:event-1' --profile 'corp-a' --format json",
    );
  });

  it('引用字段不全的群事件使用 group send', () => {
    const event = personalEvent({ messageId: undefined, senderOpenDingtalkId: undefined });
    expect(buildDwsPersonalMessageCommand(account, event, '群回复', 'idem-group')).toBe(
      "dws chat message send --group 'cid-1' --text '群回复' --uuid 'idem-group' --profile 'corp-a' --format json",
    );
  });

  it('引用字段不全的单聊事件使用 open-dingtalk-id send', () => {
    const event = personalEvent({
      type: 'user_im_message_receive_o2o_all',
      conversationId: undefined,
      messageId: undefined,
    });
    expect(buildDwsPersonalMessageCommand(account, event, '单聊回复', 'idem-o2o')).toBe(
      "dws chat message send --open-dingtalk-id 'sender-1' --text '单聊回复' --uuid 'idem-o2o' --profile 'corp-a' --format json",
    );
  });

  it('对目标、正文、uuid 和 profile 的 shell 元字符逐项单引号转义', () => {
    const dangerousAccount = { ...account, profileId: "corp'; echo profile" };
    const dangerousEvent = personalEvent({
      conversationId: "cid'; touch /tmp/pwn",
      messageId: undefined,
      senderOpenDingtalkId: undefined,
    });
    const command = buildDwsPersonalMessageCommand(
      dangerousAccount,
      dangerousEvent,
      "hello'; $(touch /tmp/text)\nnext",
      "uuid'; echo nope",
    );

    expect(command).toBe(
      "dws chat message send --group 'cid'\"'\"'; touch /tmp/pwn' --text 'hello'\"'\"'; $(touch /tmp/text)\nnext' --uuid 'uuid'\"'\"'; echo nope' --profile 'corp'\"'\"'; echo profile' --format json",
    );
  });

  it('profile、正文、幂等键或事件目标缺失时 fail closed', () => {
    expect(() => buildDwsPersonalMessageCommand(
      { ...account, profileId: undefined }, personalEvent(), 'ok', 'idem',
    )).toThrow(/profile/);
    expect(() => buildDwsPersonalMessageCommand(account, personalEvent(), '   ', 'idem')).toThrow(/正文/);
    expect(() => buildDwsPersonalMessageCommand(account, personalEvent(), 'ok', '   ')).toThrow(/幂等键/);
    expect(() => buildDwsPersonalMessageCommand(
      account,
      personalEvent({ conversationId: undefined, messageId: undefined, senderOpenDingtalkId: undefined }),
      'ok',
      'idem',
    )).toThrow(/conversationId/);
    expect(() => buildDwsPersonalMessageCommand(
      account,
      personalEvent({
        type: 'user_im_message_receive_o2o_all',
        conversationId: undefined,
        messageId: undefined,
        senderOpenDingtalkId: undefined,
      }),
      'ok',
      'idem',
    )).toThrow(/senderOpenDingtalkId/);
  });

  it('按 Unicode 字符截断到上限并追加明确标记', () => {
    const truncated = truncateDwsPersonalMessageText('😀'.repeat(DWS_PERSONAL_MESSAGE_MAX_CHARACTERS + 1));
    expect(Array.from(truncated)).toHaveLength(DWS_PERSONAL_MESSAGE_MAX_CHARACTERS);
    expect(truncated.endsWith(DWS_PERSONAL_MESSAGE_TRUNCATION_MARKER)).toBe(true);
  });
});

describe('DwsPersonalMessageSender transport', () => {
  it('用 Agent principal 解析远端，并在 Agent 独立 workspace 调用 Shell', async () => {
    const invoke = successfulInvoke();
    const resolveServerRemote = vi.fn(async () => ({
      baseUrl: 'http://hand.internal',
      authToken: 'remote-token',
      invokeTimeoutMs: 70_000,
    }));
    const transportFactory = vi.fn(() => ({ invoke }));
    const sender = new DwsPersonalMessageSender({
      agentCwd: '/mnt/agent-saas/workspaces',
      resolveServerRemote,
      transportFactory,
    });

    await sender.send(account, personalEvent(), '已处理', 'idem-1');

    expect(resolveServerRemote).toHaveBeenCalledWith({
      id: 'adws-1',
      username: '销售数字员工',
      tenantId: 'tenant-a',
      role: 'user',
      principalType: 'agent',
      agentId: 'oa-sales',
    });
    expect(transportFactory).toHaveBeenCalledWith({
      baseUrl: 'http://hand.internal',
      authToken: 'remote-token',
      invokeTimeoutMs: 70_000,
    });
    expect(invoke).toHaveBeenCalledOnce();
    const request = invoke.mock.calls[0]![0];
    expect(request.toolName).toBe('Shell');
    expect(request.input).toMatchObject({ timeoutMs: 60_000 });
    expect(request.context.workspace).toEqual({
      id: 'ws_tenant-a__agent_connector_oa-sales_dws',
      root: '/mnt/agent-saas/workspaces/tenant-a/.agent-connectors-oa-sales/dws',
      userId: 'adws-1',
      username: '销售数字员工',
      tenantId: 'tenant-a',
      sessionId: 'agent-dws-message-adws-1',
      sandboxScopeId: 'ws_tenant-a__agent_connector_oa-sales_dws__dws_messages',
      mountSubPath: 'workspaces/tenant-a/.agent-connectors-oa-sales/dws',
      executionTarget: 'server-remote',
    });
  });

  it('远端 reply 失败时抛脱敏错误，且不 fallback 避免双发', async () => {
    const invoke = vi.fn(async (_request: ToolInvocationRequest): Promise<ToolInvocationResponse> => ({
      status: 'error',
      error: 'request remote-secret failed: Bearer bearer-secret refresh_token=refresh-secret',
    }));
    const warn = vi.fn();
    const sender = new DwsPersonalMessageSender({
      agentCwd: '/mnt/agent-saas/workspaces',
      resolveServerRemote: vi.fn(async () => ({
        baseUrl: 'http://hand.internal',
        authToken: 'remote-secret',
      })),
      transportFactory: () => ({ invoke }),
      logger: { warn },
    });

    const error = await sender.send(account, personalEvent(), '回复', 'idem-error').then(
      () => new Error('expected send to reject'),
      caught => caught instanceof Error ? caught : new Error(String(caught)),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toMatch(/remote-secret|bearer-secret|refresh-secret/);
    expect(invoke).toHaveBeenCalledOnce();
    expect((invoke.mock.calls[0]![0].input as { command: string }).command).toContain('chat message reply');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/remote-secret|bearer-secret|refresh-secret/);
  });
});

import { describe, expect, it } from 'vitest';
import type { ApiSessionListItem } from '@agent/shared';
import {
  applySessionAgentTargetIdentity,
  definedSessionAgentTargetFields,
  needsSessionAgentTargetSync,
  sessionAgentTargetPresentation,
  SESSION_BINDING_SYNC_FAILED,
} from './sessionAgentTargetIdentity';
import { parseSessionAgentTargetIdentity } from './sessionAgentTargetIdentityParser';

const personal = { kind: 'personal', tenantId: 't1' } as const;
const expert = { kind: 'org-agent', tenantId: 't1', orgAgentId: 'expert-1' } as const;
const bound = {
  sessionId: 's1', updatedAtMs: 1, agentTarget: personal, agentTargetBindingVersion: 1,
  agentTargetSnapshot: { name: '个人 Agent', status: 'available', version: 1 } as const,
};
const unproven = { code: 'legacy_binding_unproven', message: '历史会话仅可查看', contactAdmin: true } as const;

describe('session Agent identity: pending is not unproven', () => {
  it('does not invent a personal/expert identity for an ID-only placeholder', () => {
    expect(sessionAgentTargetPresentation({})).toMatchObject({
      label: '身份同步中', unavailableReason: { code: 'session_binding_pending', contactAdmin: false },
    });
    expect(sessionAgentTargetPresentation({ orgAgentId: 'expert-1', orgAgentName: '选择器的名字' }).label).toBe('身份同步中');
    expect(needsSessionAgentTargetSync({})).toBe(true);
  });

  it('reserves binding-unproven for explicit server evidence', () => {
    expect(sessionAgentTargetPresentation({ agentTargetUnavailableReason: unproven })).toEqual({
      label: '绑定不可验证', unavailableReason: unproven,
    });
    expect(needsSessionAgentTargetSync({ agentTargetUnavailableReason: unproven })).toBe(false);
    expect(sessionAgentTargetPresentation({ agentTargetSnapshot: { name: '', status: 'unproven', version: 1 } }).label).toBe('绑定不可验证');
  });

  it('keeps cached failed reads retryable without calling them historical binding defects', () => {
    const failed = { agentTargetUnavailableReason: SESSION_BINDING_SYNC_FAILED };
    expect(sessionAgentTargetPresentation(failed)).toEqual({ label: '身份待确认', unavailableReason: SESSION_BINDING_SYNC_FAILED });
    expect(needsSessionAgentTargetSync(failed)).toBe(true);
  });

  it('uses the authoritative immutable snapshot for personal and org agents', () => {
    expect(sessionAgentTargetPresentation(bound)).toEqual({ label: '个人 Agent' });
    expect(sessionAgentTargetPresentation({ ...bound, agentTarget: expert, agentTargetSnapshot: {
      name: '订单专家（会话创建时）', status: 'available', version: 3,
    } })).toEqual({ label: '订单专家（会话创建时）' });
  });

  it('retains the server availability refusal even when a name is present', () => {
    const reason = { code: 'org_agent_disabled', message: '已停用', contactAdmin: true } as const;
    expect(sessionAgentTargetPresentation({ ...bound, agentTarget: expert, agentTargetUnavailableReason: reason,
      agentTargetSnapshot: { name: '订单专家', status: 'disabled', version: 2 },
    })).toEqual({ label: '订单专家', unavailableReason: reason });
    expect(sessionAgentTargetPresentation({ ...bound, agentTargetSnapshot: { name: '专家', status: 'revoked', version: 2 } })
      .unavailableReason).toBeDefined();
  });

  it('parses only a session- and tenant-matched authoritative response', () => {
    expect(parseSessionAgentTargetIdentity(bound, 's1', 't1')).toMatchObject({ agentTarget: personal });
    expect(parseSessionAgentTargetIdentity(bound, 'another-session', 't1')).toBeNull();
    expect(parseSessionAgentTargetIdentity(bound, 's1', 'another-tenant')).toBeNull();
    expect(parseSessionAgentTargetIdentity({ sessionId: 's1' }, 's1', 't1')).toBeNull();
    expect(parseSessionAgentTargetIdentity({ sessionId: 's1', agentTargetUnavailableReason: unproven }, 's1', 't1'))
      .toEqual({ agentTargetUnavailableReason: unproven });
  });

  it.each([
    { agentTarget: { kind: 'personal' } },
    { agentTargetBindingVersion: 0 },
    { agentTargetSnapshot: { name: '', status: 'available', version: 1 } },
    { agentTargetSnapshot: { name: '专家', status: 'available', version: NaN } },
    { agentTargetSnapshot: { name: '专家', status: 'revoked', version: 2 } },
    { agentTargetUnavailableReason: { code: 'invented', message: 'x', contactAdmin: true } },
  ])('does not turn malformed/partial metadata into permission to send: %j', (patch) => {
    expect(parseSessionAgentTargetIdentity({ ...bound, ...patch }, 's1', 't1')).toBeNull();
  });

  it('upsert projection keeps all canonical fields without undefined overwrites', () => {
    const fields = definedSessionAgentTargetFields(bound);
    expect(fields).toEqual({ agentTarget: personal, agentTargetBindingVersion: 1, agentTargetSnapshot: bound.agentTargetSnapshot });
    expect(definedSessionAgentTargetFields({ agentTarget: undefined, agentTargetSnapshot: undefined })).toEqual({});
  });

  it('backfills only identity; title, ordering, messages and unrelated metadata stay untouched', () => {
    const original = { sessionId: 's1', updatedAtMs: 12, title: '正在生成的标题', preview: '新消息' };
    const [result] = applySessionAgentTargetIdentity([original], 's1', definedSessionAgentTargetFields(bound));
    expect(result).toEqual({ ...original, ...definedSessionAgentTargetFields(bound) });
    expect(original).not.toHaveProperty('agentTarget');
  });

  it('never recreates a deleted row or overwrites a concurrently resolved/revoked identity', () => {
    const empty: ApiSessionListItem[] = [];
    expect(applySessionAgentTargetIdentity(empty, 's1', bound)).toBe(empty);
    const newer: ApiSessionListItem[] = [{ ...bound, agentTargetSnapshot: { name: '专家', status: 'revoked', version: 3 },
      agentTargetUnavailableReason: { code: 'org_agent_unassigned', message: '已撤销', contactAdmin: true },
    }];
    expect(applySessionAgentTargetIdentity(newer, 's1', bound)).toBe(newer);
  });

  it('does not silently change an already known target while filling a missing snapshot', () => {
    const original = { sessionId: 's1', updatedAtMs: 1, agentTarget: expert };
    const [result] = applySessionAgentTargetIdentity([original], 's1', bound);
    expect(result?.agentTarget).toEqual(expert);
    expect(result?.agentTargetUnavailableReason).toEqual(SESSION_BINDING_SYNC_FAILED);
  });
});

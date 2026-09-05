import { describe, expect, it } from 'vitest';
import type { ApiSessionListItem } from '@agent/shared';
import { toSidebarSessions } from './sessionListAdapter';

function apiSession(
  partial: Partial<ApiSessionListItem> & { sessionId: string },
): ApiSessionListItem {
  return { updatedAtMs: 1_000, ...partial };
}

describe('toSidebarSessions', () => {
  it('透传未读标记并补齐标题缺省', () => {
    const [row] = toSidebarSessions([apiSession({ sessionId: 's1', hasUnreadAiReply: true })]);
    expect(row.hasUnreadAiReply).toBe(true);
    expect(row.title).toBe('新对话');
    expect(row.createdAt).toBe(1_000);
  });

  it('待人工交互映射成等待态，优先于运行中', () => {
    const [row] = toSidebarSessions(
      [
        apiSession({
          sessionId: 's1',
          activeInteraction: { interactionId: 'i1', type: 'ask_user', version: 1 },
        }),
      ],
      's1',
    );
    expect(row.runtimeStatus).toBe('waiting_user');
    expect(row.isRunning).toBe(true);
  });

  it('只有当前运行会话标记为运行中', () => {
    const rows = toSidebarSessions(
      [apiSession({ sessionId: 's1' }), apiSession({ sessionId: 's2' })],
      's2',
    );
    expect(rows.map((r) => r.isRunning)).toEqual([false, true]);
    expect(rows[1].runtimeStatus).toBe('running');
    expect(rows[0].runtimeStatus).toBeUndefined();
  });

  it('绑定快照与不可用原因原样透传，不做本地推断', () => {
    const [row] = toSidebarSessions([
      apiSession({
        sessionId: 's1',
        agentTarget: { kind: 'org-agent', tenantId: 't-1', orgAgentId: 'oa-1' },
        agentTargetSnapshot: { name: '专家', status: 'available', version: 3 },
      }),
    ]);
    expect(row.agentTarget).toEqual({ kind: 'org-agent', tenantId: 't-1', orgAgentId: 'oa-1' });
    expect(row.agentTargetSnapshot?.name).toBe('专家');
    expect(row.agentTargetUnavailableReason).toBeUndefined();
  });
});

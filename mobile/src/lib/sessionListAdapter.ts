/**
 * API 会话列表 → 侧栏会话列表的适配。
 *
 * 未读、等待人工、运行中三种行内元信息全部来自服务端字段
 * （`hasUnreadAiReply` / `activeInteraction`）与调用方给出的当前运行会话，
 * 不在 UI 侧靠超时或本地状态猜测。
 */
import type { ApiSessionListItem, ChatSessionIndexItem } from '@agent/shared';
import { resolveSessionListRuntimeStatus } from '@agent/shared';

export function toSidebarSessions(
  sessions: readonly ApiSessionListItem[],
  runningSessionId: string | null = null,
): ChatSessionIndexItem[] {
  return sessions.map((s) => {
    const running = runningSessionId !== null && runningSessionId === s.sessionId;
    return {
      id: s.sessionId,
      title: s.title || '新对话',
      createdAt: s.createdAtMs || s.updatedAtMs,
      updatedAt: s.updatedAtMs,
      preview: s.preview,
      hasUnreadAiReply: s.hasUnreadAiReply === true,
      isRunning: running,
      runtimeStatus: resolveSessionListRuntimeStatus({
        activeInteraction: s.activeInteraction,
        running,
      }),
      source: s.source,
      owner: s.owner,
      cronJobId: s.cronJobId,
      cronJobName: s.cronJobName,
      orgAgentId: s.orgAgentId,
      orgAgentName: s.orgAgentName,
      orgAgentAvailable: s.orgAgentAvailable,
      agentTarget: s.agentTarget,
      agentTargetSnapshot: s.agentTargetSnapshot,
      agentTargetUnavailableReason: s.agentTargetUnavailableReason,
    };
  });
}

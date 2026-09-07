import type { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { PushSender } from '../push/sender.js';

export async function notifyWebPushForRuntimeEvent(
  event: PlatformEvent,
  deps: {
    service: PushSender;
    sessionStore: PgSessionProjectionStore;
  },
): Promise<void> {
  const notification = notificationFromEvent(event);
  if (!notification || !event.sessionId) return;

  const session = await deps.sessionStore.get(event.sessionId);
  if (!session?.tenantId || !session.userId) return;
  if (event.type === 'interaction_requested' && event.userId && event.userId !== session.userId) return;

  // 等待类事件不复用会话标题：标题可能来自用户输入，锁屏通知只允许任务名和状态。
  const title = notification.taskName
    ?? session.metaJson.cronJobName
    ?? 'Agent 任务';

  await deps.service.send({
    tenantId: session.tenantId,
    userId: session.userId,
    eventKey: event.type === 'background_task_finished'
      ? `background:${event.taskId}:${event.status}`
      : `runtime:${event.id}`,
    taskName: title,
    status: notification.status,
    url: `/chat/${encodeURIComponent(event.sessionId)}`,
  });
}

function notificationFromEvent(event: PlatformEvent): { status: string; taskName?: string } | null {
  if (event.type === 'background_task_finished') {
    if (event.agentType === 'command' || (event.status !== 'completed' && event.status !== 'failed')) return null;
    return {
      status: event.status === 'completed' ? '执行成功' : '执行失败',
      taskName: event.description || '后台 Agent 任务',
    };
  }
  if (event.type === 'approval_requested') {
    return { status: '等待你的确认' };
  }
  if (event.type === 'approval_resolved') {
    return {
      status: event.decision === 'approved'
        ? '确认完成'
        : event.decision === 'rejected'
          ? '确认已拒绝'
          : '确认已超时',
    };
  }
  if (event.type === 'interaction_requested' && event.interactionType === 'ask_user') {
    return { status: '等待你补充信息' };
  }
  return null;
}

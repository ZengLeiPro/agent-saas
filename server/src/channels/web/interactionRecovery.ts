import type { AskUserQuestion } from '../../types/index.js';
import type { PlatformEvent } from '../../runtime/types.js';

/**
 * pending 交互的数据形态（与 interactionStore.getPendingInteractions 同构）。
 */
export interface PendingInteractionShape {
  interactionId: string;
  type: 'ask_user' | 'permission_request';
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
  questions?: AskUserQuestion[];
  toolId?: string;
  toolName?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  planContent?: string;
}

/** 通知当前用户触发 resume，接收跨进程 durable interaction 的实时投影。 */
export function notifyCrossProcessInteractionResume(
  event: PlatformEvent,
  sessionId: string,
  fallbackUserId: string | undefined,
  inProcessRunIds: ReadonlySet<string>,
  emitUser: (userId: string, data: object) => void,
): void {
  if (event.type !== 'interaction_requested') return;
  const runId = event.runId;
  if (!runId || !['ask_user', 'permission_request'].includes(event.interactionType)) return;
  if (inProcessRunIds.has(runId)) return;
  const userId = event.userId ?? fallbackUserId;
  if (!userId) return;
  emitUser(userId, { type: 'stream_started', sessionId, streamId: runId, runId });
}

/**
 * TASK-63：跨进程/后台 run 的 ask_user 只写 EventBuffer（emitSession 在无
 * activeEntry 时用 dummy ws，不直推），且 web 进程 interactionStore 无该交互
 * 条目（interaction 在 run 执行进程创建）。前端在 stream_started 触发的 resume
 * 无游标（lastEventId=0 且无 durable cursor）时，回放边界为 buffer 末尾，已入
 * buffer 的 ask_user 会被跳过——这里把 buffer 中仍处于 pending 的
 * ask_user/permission_request 扫描出来，作为 interactionStore 的补充恢复来源，
 * 保证「停留在会话页」的用户也能在 resume 后立即看到提问表单，不必刷新或切换
 * 会话。扫描是同步的，复用 EventBufferStore.getEventsAfter(sid, 0) 的快照，
 * 不引入新的权限面（调用点已完成用户归属校验）。
 *
 * 去重说明：`interaction_resolved` 事件走 emitUser（per-user）+ durable
 * eventStore，从不写入会话 EventBuffer，因此此处不做基于 buffer 的 resolved
 * 去重（buffer 内不存在该事件）。重复/已应答交互的去重由以下既有机制兜底：
 * interactionStore.getPendingInteractions（同进程内存态）与前端按 interactionId
 * 去重。跨进程已 resolved 交互的权威去重建议后续改用 durable 记录（review
 * 2026-08-17 非阻塞项）。
 */
export function scanBufferForPendingInteractions(
  bufferedEvents: ReadonlyArray<{ data: string }> | undefined,
  known: ReadonlySet<string>,
): PendingInteractionShape[] {
  const result: PendingInteractionShape[] = [];
  if (!bufferedEvents) return result;
  for (const evt of bufferedEvents) {
    try {
      const data = JSON.parse(evt.data) as Record<string, unknown>;
      if (!data || typeof data.type !== 'string') continue;
      if (
        (data.type === 'ask_user' || data.type === 'permission_request')
        && typeof data.interactionId === 'string'
        && !known.has(data.interactionId)
      ) {
        result.push({
          interactionId: data.interactionId,
          type: data.type,
          ...(typeof data.runId === 'string' ? { runId: data.runId } : {}),
          ...(typeof data.toolCallId === 'string' ? { toolCallId: data.toolCallId } : {}),
          ...(typeof data.invocationId === 'string' ? { invocationId: data.invocationId } : {}),
          ...(typeof data.toolId === 'string' ? { toolId: data.toolId } : {}),
          ...(typeof data.toolName === 'string' ? { toolName: data.toolName } : {}),
          ...(typeof data.displayName === 'string' ? { displayName: data.displayName } : {}),
          questions: Array.isArray(data.questions) ? data.questions as AskUserQuestion[] : [],
          ...(data.toolInput !== undefined ? { toolInput: data.toolInput as Record<string, unknown> } : {}),
        });
      }
    } catch {
      // 非 JSON/畸形 buffer 条目跳过
    }
  }
  return result;
}

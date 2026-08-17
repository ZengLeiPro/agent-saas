import type { AskUserQuestion } from '../../types/index.js';

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
 */
export function scanBufferForPendingInteractions(
  bufferedEvents: ReadonlyArray<{ data: string }> | undefined,
  known: ReadonlySet<string>,
): PendingInteractionShape[] {
  const result: PendingInteractionShape[] = [];
  if (!bufferedEvents) return result;
  const resolvedIds = new Set<string>();
  for (const evt of bufferedEvents) {
    try {
      const data = JSON.parse(evt.data) as Record<string, unknown>;
      if (!data || typeof data.type !== 'string') continue;
      if (data.type === 'interaction_resolved' && typeof data.interactionId === 'string') {
        resolvedIds.add(data.interactionId);
        continue;
      }
      if (
        (data.type === 'ask_user' || data.type === 'permission_request')
        && typeof data.interactionId === 'string'
        && !known.has(data.interactionId)
        && !resolvedIds.has(data.interactionId)
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

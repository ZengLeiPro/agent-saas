import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import type { TaskboardExecutionStore } from './types.js';

export async function reconcileTerminalContinuation(input: {
  store: TaskboardExecutionStore;
  eventStore: EventStore;
  taskId: string;
  run: RunRecord;
}): Promise<TaskBoardTask | null> {
  const { store, eventStore, taskId, run } = input;
  if (run.status === 'completed') {
    const events = eventStore.listByRun
      ? await eventStore.listByRun(run.sessionId, run.runId)
      : await eventStore.list(run.sessionId);
    const output = finalAssistantText(events, run.runId, run.sessionId)
      || 'Agent 继续执行完成，但没有返回文本交付。';
    return store.completeContinuation(taskId, run.runId, {
      status: 'succeeded',
      commentBody: limitComment(`Agent 交付\n\n${stripFileMarkers(output)}`),
    });
  }
  if (run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'orphaned') return null;
  const cancelled = run.status === 'cancelled';
  const reason = run.statusReason || `Runtime 状态：${run.status}`;
  return store.completeContinuation(taskId, run.runId, {
    status: cancelled ? 'cancelled' : 'failed',
    error: reason,
    commentBody: limitComment(`Agent 继续执行${cancelled ? '已取消' : '失败'}\n\n${reason}`),
  });
}

function finalAssistantText(events: PlatformEvent[], runId: string, sessionId: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant_message' || event.incomplete
      || event.runId !== runId || event.sessionId !== sessionId) continue;
    const content = event.content?.trim();
    if (content) return content;
  }
  return '';
}

function stripFileMarkers(output: string): string {
  return output.replace(/\[FILE\]\{.*?\}\[\/FILE\]/g, '').trim();
}

function limitComment(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 20_000) return normalized;
  return `${normalized.slice(0, 19_950)}\n\n[回执内容过长，已截断]`;
}

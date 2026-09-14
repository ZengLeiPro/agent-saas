import type { RenderItem } from '@/components/types';
import type { BubbleRenderItem } from '@/components/groupIntoBubbles';

function firstTimestamp(items: readonly RenderItem[]): number | undefined {
  for (const item of items) {
    if ('timestamp' in item && typeof item.timestamp === 'number') return item.timestamp;
    if (item.type === 'activity_group' || item.type === 'business_step_section') {
      const nested = firstTimestamp(item.items);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function firstRunId(items: readonly RenderItem[]): string | undefined {
  for (const item of items) {
    if ('runId' in item && typeof item.runId === 'string' && item.runId) return item.runId;
    if (item.type === 'activity_group' || item.type === 'business_step_section') {
      const nested = firstRunId(item.items);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * 虚拟行身份必须跟业务轮次走，不能跟当前第一个可见子项走。
 *
 * runtime_status 会在 queued/running 后被首个 thinking/text/tool 替换。如果用
 * 子项 id 作 key，同一轮 AI 气泡会被 React 当成新行，已测高度与已解码媒体一起
 * 丢失。runId 是服务端在整轮生命周期内保持不变的稳定身份。
 */
export function getBubbleVirtualKey(item: BubbleRenderItem): string {
  if (item.type === 'ai_bubble') {
    const runId = firstRunId(item.items);
    if (runId) return `assistant-run:${runId}`;
    return `${item.id}:${firstTimestamp(item.items) ?? ''}`;
  }

  const timestamp =
    'timestamp' in item
      ? item.timestamp
      : item.type === 'activity_group'
        ? firstTimestamp(item.items)
        : undefined;
  return `${item.id}:${timestamp ?? ''}`;
}

function userTurnAnchor(item: BubbleRenderItem): string | undefined {
  if (item.type !== 'user' && item.type !== 'user-voice') return undefined;
  return `${item.clientMsgId ?? item.id}:${item.timestamp ?? ''}`;
}

/**
 * 实时 AI 行优先绑定前一条用户提交。发送阶段尚无 runId，服务端确认后才补上；
 * 用户提交身份贯穿 sending -> queued/running -> 首段输出，可避免补 runId 时先抖一次。
 * 同一轮被 finalOutput 切成多段时，再追加段序号避免重复 React key。
 */
export function getBubbleVirtualKeys(items: readonly BubbleRenderItem[]): string[] {
  const occurrences = new Map<string, number>();
  let activeUserTurn: string | undefined;
  return items.map((item) => {
    activeUserTurn = userTurnAnchor(item) ?? activeUserTurn;
    const base =
      item.type === 'ai_bubble' && activeUserTurn
        ? `assistant-turn:${activeUserTurn}`
        : getBubbleVirtualKey(item);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:segment-${occurrence + 1}`;
  });
}

export type {
  ApiSessionListItem,
  ApiSessionDetail,
  TokenUsage,
  ApiTranscriptBlock,
  SessionSearchMatchKind,
  SessionSearchMatchRange,
  SessionSearchMatch,
  SessionSearchHit,
  SessionSearchResponse,
  SearchSessionsParams,
} from '@agent/shared';
export { formatTokenCount, searchSessions } from '@agent/shared';

import { mapSessionDetailToMessages as sharedMapSessionDetailToMessages } from '@agent/shared';
import type { ApiSessionDetail, MessageItem } from '@agent/shared';
import { compactionItemFromBlock } from '@/lib/compaction';

/**
 * 会话重载映射：在 shared 版基础上补充 kind='compaction' block →「上下文已压缩」分界线。
 *
 * shared 的 mapSessionDetailToMessages 会丢弃未知 kind（本次改动仅允许动 web/src），
 * 这里按 block 顺序把分界线插回正确位置：其后第一个有渲染产物的 block 之前；
 * 若其后没有任何可渲染 block 则追加到末尾。
 */
export function mapSessionDetailToMessages(detail: ApiSessionDetail, owner?: string): MessageItem[] {
  const base = sharedMapSessionDetailToMessages(detail, owner);
  if (!detail.blocks.some((b) => (b.kind as string) === 'compaction')) return base;

  // 映射产物 id 与 block.id 同源（mapBlock 用 block.id 作消息 id），据此定位插入点
  const idToIndex = new Map<string, number>();
  base.forEach((m, i) => {
    if (!idToIndex.has(m.id)) idToIndex.set(m.id, i);
  });

  const insertions: Array<{ at: number; item: MessageItem }> = [];
  for (let i = 0; i < detail.blocks.length; i++) {
    const block = detail.blocks[i];
    if ((block.kind as string) !== 'compaction') continue;
    let at = base.length;
    for (let j = i + 1; j < detail.blocks.length; j++) {
      const mapped = idToIndex.get(detail.blocks[j].id);
      if (mapped !== undefined) {
        at = mapped;
        break;
      }
    }
    insertions.push({ at, item: compactionItemFromBlock(block) });
  }

  // 从后往前插入，避免前面的插入使 at 位移；同位置多条时保持原相对顺序
  const result = [...base];
  for (let k = insertions.length - 1; k >= 0; k--) {
    result.splice(insertions[k].at, 0, insertions[k].item);
  }
  return result;
}

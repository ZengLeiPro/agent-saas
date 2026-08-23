import { mapSessionDetailToMessages as sharedMapSessionDetailToMessages } from '@agent/shared';
import type { ApiSessionDetail, MessageItem } from '@agent/shared';

import { compactionItemFromBlock } from '@/lib/compaction';

/**
 * 会话重载映射：在 shared 版基础上补充 kind='compaction' block →「上下文已压缩」分界线。
 *
 * 该模块只在读取会话详情时加载，不进入首屏包。
 */
export function mapSessionDetailToMessages(
  detail: ApiSessionDetail,
  owner?: string,
): MessageItem[] {
  const base = sharedMapSessionDetailToMessages(detail, owner);
  if (!detail.blocks.some((block) => (block.kind as string) === 'compaction')) return base;

  const idToIndex = new Map<string, number>();
  base.forEach((message, index) => {
    if (!idToIndex.has(message.id)) idToIndex.set(message.id, index);
  });

  const insertions: Array<{ at: number; item: MessageItem }> = [];
  for (let index = 0; index < detail.blocks.length; index++) {
    const block = detail.blocks[index];
    if ((block.kind as string) !== 'compaction') continue;
    let at = base.length;
    for (let cursor = index + 1; cursor < detail.blocks.length; cursor++) {
      const mapped = idToIndex.get(detail.blocks[cursor].id);
      if (mapped !== undefined) {
        at = mapped;
        break;
      }
    }
    insertions.push({ at, item: compactionItemFromBlock(block) });
  }

  const result = [...base];
  for (let index = insertions.length - 1; index >= 0; index--) {
    result.splice(insertions[index].at, 0, insertions[index].item);
  }
  return result;
}

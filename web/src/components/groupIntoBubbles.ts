import type { RenderItem } from './types';
import { asCompactionItem } from '@/lib/compaction';

interface AiBubbleGroup {
  type: 'ai_bubble';
  id: string;
  items: RenderItem[];
}

export type BubbleRenderItem = RenderItem | AiBubbleGroup;

/** 同一轮过程文本、活动与最终回答保持在一个 AI 气泡；用户和中性事件仍是硬边界。 */
export function groupIntoBubbles(items: RenderItem[]): BubbleRenderItem[] {
  const result: BubbleRenderItem[] = [];
  let currentGroup: RenderItem[] = [];

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    result.push({
      type: 'ai_bubble',
      id: `bubble-${currentGroup[0].id}`,
      items: [...currentGroup],
    });
    currentGroup = [];
  };

  for (const item of items) {
    if (item.type === 'file_download') {
      // [FILE] 标记已在正文内联；有 artifactId 的 legacy 文件卡保持独立。
      if (!item.artifactId) continue;
      flushGroup();
      result.push(item);
      continue;
    }
    if (
      item.type === 'user' ||
      item.type === 'user-voice' ||
      item.type === 'system-error' ||
      item.type === 'system_event' ||
      asCompactionItem(item)
    ) {
      flushGroup();
      result.push(item);
      continue;
    }

    currentGroup.push(item);
    if (item.type === 'voice' || (item.type === 'text' && item.finalOutput)) flushGroup();
  }

  flushGroup();
  return result;
}

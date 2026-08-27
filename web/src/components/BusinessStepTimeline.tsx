import type { ReactNode } from 'react';
import type { RenderItem } from './types';

interface BusinessStepRun {
  type: 'business_step_run';
  id: string;
  items: RenderItem[];
}

function isCompactBusinessStep(item: RenderItem): boolean {
  return (
    item.type === 'business_step_section' || (item.type === 'business_step' && item.kind !== 'plan')
  );
}

/**
 * 折叠步骤是同一条业务时间线，不是彼此独立的消息块。把连续步骤收成一组后，
 * 组内使用更紧凑的 6px 节奏；计划亮相块与普通消息仍由外层 10px gap 分隔。
 */
function groupBusinessStepRuns(items: RenderItem[]): Array<RenderItem | BusinessStepRun> {
  const result: Array<RenderItem | BusinessStepRun> = [];
  let currentRun: RenderItem[] = [];

  const flushRun = () => {
    if (!currentRun.length) return;
    result.push({
      type: 'business_step_run',
      id: `business-run-${currentRun[0].id}`,
      items: currentRun,
    });
    currentRun = [];
  };

  for (const item of items) {
    if (isCompactBusinessStep(item)) {
      currentRun.push(item);
      continue;
    }
    flushRun();
    result.push(item);
  }
  flushRun();
  return result;
}

export function BusinessStepTimeline({
  items,
  renderItem,
}: {
  items: RenderItem[];
  renderItem: (item: RenderItem) => ReactNode;
}) {
  return groupBusinessStepRuns(items).map((item) => {
    if (item.type === 'business_step_run') {
      return (
        <div key={item.id} className="flex flex-col gap-1.5" data-business-step-run>
          {item.items.map((step) => renderItem(step))}
        </div>
      );
    }
    if (item.type === 'file_download') return null;
    return renderItem(item);
  });
}

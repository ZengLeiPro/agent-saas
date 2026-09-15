import { useState, type ReactNode } from 'react';
import type { RenderItem } from './types';
import { AgentActivityShell, type AgentActivityState } from './AgentActivityShell';
import { businessStepMainItems } from './BusinessStepTimeline';
import { partitionAssistantTurn, selectTurnProcessSummary, type TurnProcessSummary } from '@agent/shared';

function shellState(tone: TurnProcessSummary['tone']): AgentActivityState {
  if (tone === 'active') return 'running';
  if (tone === 'warning') return 'warning';
  if (tone === 'pending') return 'waiting';
  if (tone === 'neutral') return 'cancelled';
  if (tone === 'danger') return 'failed';
  return 'completed';
}

/**
 * 一轮完成后的过程折行。视觉复用 AgentActivityShell，不要复用 ActivityGroupBlock，
 * 以免和组内工具展开态抢 state。默认收起；刷新回到默认收起。
 */
export function TurnProcessFold({
  items,
  renderItem,
}: {
  items: RenderItem[];
  renderItem: (item: RenderItem) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = selectTurnProcessSummary(items);

  return (
    <div data-testid="turn-process-fold" data-expanded={expanded ? 'true' : 'false'}>
      <AgentActivityShell
        state={shellState(summary.tone)}
        title={summary.title}
        subtitle={summary.subtitle}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      >
        <div className="flex flex-col gap-2.5 [&>*]:my-0">
          {items.map((item) => renderItem(item))}
        </div>
      </AgentActivityShell>
    </div>
  );
}

/** 终态才折；运行中走原投影顺序，避免打断 layoutStability。 */
export function AssistantTurnItems({
  items,
  renderItem,
}: {
  items: RenderItem[];
  renderItem: (item: RenderItem) => ReactNode;
}) {
  const projected = businessStepMainItems(items);
  const partition = partitionAssistantTurn(projected);
  if (!partition.shouldFold) return projected.map(renderItem);
  return (
    <>
      <TurnProcessFold items={partition.process} renderItem={renderItem} />
      {partition.keepOut.map(renderItem)}
      {partition.pierce.map(renderItem)}
      {partition.final.map(renderItem)}
    </>
  );
}

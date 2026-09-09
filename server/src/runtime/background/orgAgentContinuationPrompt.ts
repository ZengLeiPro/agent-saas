import type { OrgAgentWorkOrder } from '../../data/orgGroupAgents/index.js';

export function withWorkOrderContinuationPrompt(
  basePrompt: string,
  work: OrgAgentWorkOrder,
  previousAttemptPrompt: string,
): string {
  const controlPrompt = withWorkOrderControlPrompt(work);
  return `${basePrompt}\n\n${previousAttemptPrompt}${controlPrompt}`;
}

function withWorkOrderControlPrompt(work: OrgAgentWorkOrder): string {
  if (work.control.supplements.length === 0) return '';
  const additions = work.control.supplements
    .map(
      (item, index) =>
        `${index + 1}. [${item.kind === 'review' ? '复核要求' : '补充要求'}] ${item.text}`,
    )
    .join('\n');
  return `\n\n<work-order-continuation revision="${work.control.revision}">\n${additions}\n</work-order-continuation>`;
}

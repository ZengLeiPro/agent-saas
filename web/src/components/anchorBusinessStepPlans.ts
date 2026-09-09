import type { RenderItem } from './types';

type BusinessStep = Extract<RenderItem, { type: 'business_step' }>;

/** Only sent/sending messages are interjections; queued and failed messages are not replies. */
function isInterjection(item: RenderItem): boolean {
  return (
    (item.type === 'user' && item.status !== 'queued' && item.status !== 'failed') ||
    (item.type === 'user-voice' && item.status === 'sent')
  );
}

/**
 * Move the single plan card, not its transcript or detail sections. Confirmed same-run
 * activity makes the anchor reproducible on replay; a current step also lets a newly
 * sent interjection move the card immediately, before the next Agent event arrives.
 */
export function anchorBusinessStepPlans(
  items: readonly RenderItem[],
  mainItems: readonly RenderItem[],
): RenderItem[] {
  const anchors = new Map<string, string>();
  let plan: BusinessStep | undefined;
  let lastUserId: string | undefined;
  let isCurrent = false;

  const endRun = () => {
    plan = undefined;
    lastUserId = undefined;
    isCurrent = false;
  };

  const visit = (item: RenderItem): void => {
    if (item.type === 'business_step' && item.kind === 'plan') {
      plan = item;
      lastUserId = undefined;
      isCurrent = item.isCurrent === true;
      return;
    }
    if (!plan) return;

    if (isInterjection(item)) {
      lastUserId = item.id;
      return;
    }
    if (item.type === 'user' || item.type === 'user-voice') return;

    if (item.type === 'business_step_section') {
      visit(item.start);
      if (plan && item.isActive) isCurrent = true;
      item.items.forEach(visit);
      if (item.terminal) visit(item.terminal);
      return;
    }
    if (item.type === 'activity_group') {
      item.items.forEach(visit);
      return;
    }

    // A new run without TodoWrite must not inherit the previous run's plan either.
    if ('runId' in item && item.runId && plan.runId) {
      if (item.runId !== plan.runId) {
        endRun();
        return;
      }
      if (lastUserId) anchors.set(plan.id, lastUserId);
    }

    // A final answer, interruption or explicit reset is a hard boundary. Do not
    // move an old card under the next task merely because that task is loading.
    if (
      item.type === 'system-error' ||
      item.type === 'system_event' ||
      (item.type === 'text' && item.finalOutput) ||
      (item.type === 'business_step' && item.kind === 'reset')
    ) {
      endRun();
      return;
    }
    if (item.type === 'business_step' && item.isCurrent) isCurrent = true;
  };

  items.forEach(visit);
  if (plan && !plan.isClosed && isCurrent && lastUserId) {
    anchors.set(plan.id, lastUserId);
  }

  // Only remove a card when its destination is visible. Reuse the same object/id
  // so detail selection, progress, and history remain attached to the same plan.
  const visibleIds = new Set(mainItems.map((item) => item.id));
  const movedIds = new Set<string>();
  const plansByUser = new Map<string, RenderItem[]>();
  for (const item of mainItems) {
    if (item.type !== 'business_step' || item.kind !== 'plan') continue;
    const anchor = anchors.get(item.id);
    if (!anchor || !visibleIds.has(anchor)) continue;
    const plans = plansByUser.get(anchor) ?? [];
    plans.push(item);
    plansByUser.set(anchor, plans);
    movedIds.add(item.id);
  }

  const result: RenderItem[] = [];
  for (const item of mainItems) {
    if (movedIds.has(item.id)) continue;
    result.push(item);
    const plans = plansByUser.get(item.id);
    if (plans) result.push(...plans);
  }
  return result;
}

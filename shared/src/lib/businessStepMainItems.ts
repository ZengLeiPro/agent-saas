import type { RenderItem } from '../types/message';

/**
 * 主对话区投影（与 `web/src/components/BusinessStepTimeline.tsx` 同源下沉）。
 *
 * 规则：
 * 1. 步骤过程（start/complete/update/… 事件与 section 正文）不在主区重复打印，
 *    完整投影仍留在详情目录里；
 * 2. 计划卡每个业务 Run 只保留**最新**一张——长会话里一个 Run 会随 TodoWrite
 *    刷新出多张历史计划卡，主区只应看到当前那张；
 * 3. section 内部只捞回真实人工门禁（权限/追问）与排队中的用户插话，
 *    它们是「必须让人看见并动手」的内容，不能被过程折叠吃掉。
 */
function mainConversationItems(items: readonly RenderItem[]): RenderItem[] {
  const interactions: RenderItem[] = [];
  for (const item of items) {
    if (
      item.type === 'permission_request' ||
      item.type === 'ask_user' ||
      (item.type === 'user' && item.status === 'queued')
    ) {
      interactions.push(item);
    }
  }
  return interactions;
}

/** 计划卡的 Run 归属键：runId 缺省时退到计划世代，再退到 anchor 消息。 */
function planGroupKey(item: Extract<RenderItem, { type: 'business_step' }>): string {
  return item.runId ?? item.generationId ?? item.anchorMessageId;
}

export interface BusinessStepMainItemsOptions {
  /**
   * 步骤节的处理方式：
   * - `flatten`（默认，Web 主区口径）：节正文交给详情面板，主区只捞回门禁与排队插话；
   * - `keep`：节按原样保留，由渲染层自己内联折叠过程（移动端没有并排详情面板，
   *   步骤节就是它的详情载体，拍平等于删掉整段叙事）。
   */
  sections?: 'flatten' | 'keep';
}

export function businessStepMainItems(
  items: readonly RenderItem[],
  options: BusinessStepMainItemsOptions = {},
): RenderItem[] {
  // 先记下每个 Run 最后一张计划卡的下标，再单趟输出——避免长会话里堆叠历史计划卡。
  const latestPlanIndexByRun = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.type === 'business_step' && item.kind === 'plan') {
      latestPlanIndexByRun.set(planGroupKey(item), index);
    }
  });

  const result: RenderItem[] = [];
  items.forEach((item, index) => {
    if (item.type === 'business_step') {
      if (item.kind === 'plan' && latestPlanIndexByRun.get(planGroupKey(item)) === index) {
        result.push(item);
      }
      return;
    }
    if (item.type === 'business_step_section') {
      if (options.sections === 'keep') result.push(item);
      else result.push(...mainConversationItems(item.items));
      return;
    }
    result.push(item);
  });
  return result;
}

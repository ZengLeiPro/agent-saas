/**
 * 步进器 ⇄ 草稿字符串的纯映射。
 *
 * 草稿里的「最大轮次 / 超时」沿用 Web 的字符串形态（空串 = 留空，走服务端默认），
 * 步进器只能表达数字，因此约定 **0 档 = 留空**：
 *   - 最大轮次：Web 的 min 就是 1，0 不是合法业务值，用作「默认」哨兵无歧义；
 *   - 超时：Web 允许 `0 = 不设置超时`，移动端不提供这一档（把 0 让给「默认」），
 *     需要关闭超时请去 Web 设置——这是刻意的安全默认，不是遗漏。
 */

/** 草稿字符串 → 步进器数值；非正数与非法值一律回落 0（留空/默认）。 */
export function toCronStepperValue(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 步进器数值 → 草稿字符串；0 表示留空。 */
export function fromCronStepperValue(value: number): string {
  return value > 0 ? String(value) : '';
}

/** 最大轮次的展示文案。 */
export function formatCronMaxTurns(value: number): string {
  return value > 0 ? `${value} 轮` : '默认';
}

/** 超时的展示文案（按分钟取整）。 */
export function formatCronTimeout(seconds: number): string {
  return seconds > 0 ? `${Math.round(seconds / 60)} 分钟` : '默认';
}

// 让侧边栏用户菜单等外部入口可以命令右上角 BillingMiniBadge 展开其详情面板。
//
// 用 pending flag + listener 组合以兼容两种时机：
// 1. Badge 已经挂载：requestOpenBillingBadge() 直接触发 listener，subscriber 立即展开。
// 2. Badge 尚未挂载（如刚从其他 tab 切到 chat）：pending 标志被 BillingMiniBadge 挂载时消费。

type Listener = () => void;

let pending = false;
const listeners = new Set<Listener>();

/** 请求打开 BillingMiniBadge 详情面板。若组件已挂载则立即展开；否则等组件下一次挂载时自动展开。 */
export function requestOpenBillingBadge(): void {
  pending = true;
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore listener errors */
    }
  });
}

/** 挂载时读取并清除 pending 标志。返回 true 表示应立刻展开。 */
export function consumePendingBillingBadgeOpen(): boolean {
  const was = pending;
  pending = false;
  return was;
}

/** 订阅打开请求，供 BillingMiniBadge 内部在挂载期间实时响应。 */
export function subscribeBillingBadgeOpen(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 手写模态的焦点陷阱决策逻辑。
 *
 * 为什么单独抽出来：`AdminShells` 的管理设置弹窗是手写壳（有移动端两级导航、
 * 自定义栅格与安全区内边距），不是 Radix Dialog，拿不到组件库自带的焦点管理。
 * 而这段「Tab 到尾要回到头」的逻辑一旦回归不会报任何错，只有键盘用户会发现
 * 焦点跑到了模态背后的页面上——必须能单测。
 *
 * 组件里只保留事件绑定，决策全在这里，这样测试不需要渲染整个管理壳。
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function findFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface FocusTrapDecision {
  /** 该把焦点移到哪个元素。null = 不干预，交给浏览器默认 Tab 行为 */
  focus: HTMLElement | null;
  /** 是否需要 preventDefault（阻止浏览器把焦点带出去） */
  preventDefault: boolean;
}

/**
 * 给定「容器 / 当前焦点 / 是否 Shift」，决定 Tab 该落到哪。
 *
 * 三种需要干预的情况：
 *   1. 焦点在容器外（含首次打开还没聚焦）→ 拉回第一个
 *   2. 正向 Tab 且已在最后一个 → 回到第一个
 *   3. 反向 Tab 且已在第一个 → 跳到最后一个
 * 其余交给浏览器默认行为，不要多管——手工接管全部 Tab 顺序容易和
 * 原生的可访问性行为打架（比如 radio group 内的方向键语义）。
 */
export function decideFocusTrap({
  container,
  activeElement,
  shiftKey,
}: {
  container: HTMLElement;
  activeElement: Element | null;
  shiftKey: boolean;
}): FocusTrapDecision {
  const focusables = findFocusables(container);
  if (focusables.length === 0) return { focus: null, preventDefault: false };

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (!activeElement || !container.contains(activeElement)) {
    return { focus: first, preventDefault: true };
  }
  if (!shiftKey && activeElement === last) {
    return { focus: first, preventDefault: true };
  }
  if (shiftKey && activeElement === first) {
    return { focus: last, preventDefault: true };
  }
  return { focus: null, preventDefault: false };
}

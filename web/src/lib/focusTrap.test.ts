/**
 * 焦点陷阱决策的契约测试。
 *
 * 这段逻辑服务于 `AdminShells` 的手写管理设置弹窗——它标了 `aria-modal="true"`
 * 却在改造前零键盘处理。回归时不会有任何报错，只有键盘用户发现焦点跑到了模态
 * 背后的页面上，所以必须锁住。
 */
import { afterEach, describe, expect, it } from "vitest";

import { decideFocusTrap, findFocusables } from "./focusTrap";

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const THREE_BUTTONS = `
  <button id="a">A</button>
  <button id="b">B</button>
  <button id="c">C</button>
`;

describe("findFocusables", () => {
  it("收集常见可聚焦元素", () => {
    const container = mount(`
      <a href="/x">link</a>
      <button>btn</button>
      <input />
      <select></select>
      <textarea></textarea>
      <div tabindex="0">div</div>
    `);
    expect(findFocusables(container)).toHaveLength(6);
  });

  it("跳过 disabled 与 tabindex=-1", () => {
    const container = mount(`
      <button>ok</button>
      <button disabled>no</button>
      <input disabled />
      <div tabindex="-1">no</div>
    `);
    expect(findFocusables(container)).toHaveLength(1);
  });
});

describe("decideFocusTrap", () => {
  it("焦点在容器外时拉回第一个", () => {
    const container = mount(THREE_BUTTONS);
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    const decision = decideFocusTrap({ container, activeElement: outside, shiftKey: false });
    expect(decision.preventDefault).toBe(true);
    expect(decision.focus?.id).toBe("a");
  });

  it("首次打开（activeElement 为 null）也拉回第一个", () => {
    const container = mount(THREE_BUTTONS);
    const decision = decideFocusTrap({ container, activeElement: null, shiftKey: false });
    expect(decision.focus?.id).toBe("a");
  });

  it("正向 Tab 到最后一个 → 回到第一个", () => {
    const container = mount(THREE_BUTTONS);
    const last = container.querySelector<HTMLElement>("#c")!;

    const decision = decideFocusTrap({ container, activeElement: last, shiftKey: false });
    expect(decision.preventDefault).toBe(true);
    expect(decision.focus?.id).toBe("a");
  });

  it("反向 Tab 在第一个 → 跳到最后一个", () => {
    const container = mount(THREE_BUTTONS);
    const first = container.querySelector<HTMLElement>("#a")!;

    const decision = decideFocusTrap({ container, activeElement: first, shiftKey: true });
    expect(decision.preventDefault).toBe(true);
    expect(decision.focus?.id).toBe("c");
  });

  it("中间位置不干预，交给浏览器默认 Tab 行为", () => {
    const container = mount(THREE_BUTTONS);
    const middle = container.querySelector<HTMLElement>("#b")!;

    for (const shiftKey of [true, false]) {
      const decision = decideFocusTrap({ container, activeElement: middle, shiftKey });
      expect(decision.preventDefault).toBe(false);
      expect(decision.focus).toBeNull();
    }
  });

  it("正向 Tab 在第一个不干预（还没到边界）", () => {
    const container = mount(THREE_BUTTONS);
    const first = container.querySelector<HTMLElement>("#a")!;
    const decision = decideFocusTrap({ container, activeElement: first, shiftKey: false });
    expect(decision.focus).toBeNull();
  });

  it("容器内无可聚焦元素时不干预，避免死锁住 Tab", () => {
    const container = mount("<p>纯文本</p>");
    const decision = decideFocusTrap({ container, activeElement: null, shiftKey: false });
    expect(decision.preventDefault).toBe(false);
    expect(decision.focus).toBeNull();
  });

  it("只有一个可聚焦元素时，两个方向都停在它自己身上", () => {
    const container = mount(`<button id="only">only</button>`);
    const only = container.querySelector<HTMLElement>("#only")!;

    expect(decideFocusTrap({ container, activeElement: only, shiftKey: false }).focus?.id).toBe("only");
    expect(decideFocusTrap({ container, activeElement: only, shiftKey: true }).focus?.id).toBe("only");
  });

  it("disabled 元素不参与边界判定", () => {
    const container = mount(`
      <button id="a">A</button>
      <button id="b">B</button>
      <button id="disabled" disabled>D</button>
    `);
    const b = container.querySelector<HTMLElement>("#b")!;
    // b 是最后一个「可聚焦」元素，尽管它后面还有个 disabled 按钮
    const decision = decideFocusTrap({ container, activeElement: b, shiftKey: false });
    expect(decision.focus?.id).toBe("a");
  });
});

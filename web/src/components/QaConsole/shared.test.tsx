/**
 * 客户面质检台共用组件的契约测试。
 *
 * 这一屏是给**客户组织管理员**看的，两条红线必须锁死：
 *   1. 错误提示不得泄漏原始错误串（`HTTP 500` / 堆栈 / request id）——
 *      改造前七处直接渲染 error.message，客户会看到 `HTTP 500`
 *   2. 编号必须能完整复制——改造前只显示 `sessionId.slice(0, 8)`，
 *      客户发现问题会话想反馈给我们时手上只有半截 ID
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QaCopyableId, QaErrorNotice } from "./shared";

describe("QaErrorNotice（客户面错误提示）", () => {
  it("不泄漏原始错误串——HTTP 500 不出现在客户面前", () => {
    const { container } = render(<QaErrorNotice error={new Error("HTTP 500")} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("HTTP 500");
    expect(text).not.toContain("500");
    // 换成人话
    expect(text).toContain("暂时无法加载数据");
  });

  it("不渲染 technicalDetail（与内部运维用的 AdminErrorAlert 的关键区别）", () => {
    const { container } = render(<QaErrorNotice error={new Error("ECONNREFUSED 127.0.0.1:5432")} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("5432");
    // 展开技术详情的 <details> 不该存在
    expect(container.querySelector("details")).toBeNull();
  });

  it("能识别的错误给出对应人话与建议", () => {
    const { container } = render(<QaErrorNotice error={new Error("403 forbidden")} />);
    const text = container.textContent ?? "";
    expect(text).toContain("没有权限");
    expect(text).not.toContain("403");
    expect(text).not.toContain("forbidden");
  });

  it("超时类错误也走人话", () => {
    const { container } = render(<QaErrorNotice error={new Error("request timed out after 30000ms")} />);
    const text = container.textContent ?? "";
    expect(text).toContain("请求超时");
    expect(text).not.toContain("30000");
  });

  it("传了 onRetry 才渲染重试按钮", async () => {
    const onRetry = vi.fn();
    const { unmount } = render(<QaErrorNotice error={new Error("HTTP 500")} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    render(<QaErrorNotice error={new Error("HTTP 500")} />);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("接受字符串形式的错误", () => {
    const { container } = render(<QaErrorNotice error="401 unauthorized" />);
    const text = container.textContent ?? "";
    expect(text).toContain("登录状态已失效");
    expect(text).not.toContain("401");
  });
});

describe("QaCopyableId（客户面可复制编号）", () => {
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    writeText.mockClear();
    // navigator.clipboard 在 jsdom 里是只有 getter 的属性，Object.assign 会抛
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("只显示前 8 位，但复制的是完整编号", async () => {
    const full = "8e10b205-39d4-4157-b4f5-a647319587c6";
    render(<QaCopyableId id={full} />);

    expect(screen.getByRole("button").textContent).toContain("8e10b205");
    expect(screen.getByRole("button").textContent).not.toContain("a647319587c6");

    await userEvent.click(screen.getByRole("button"));
    // 关键：复制到剪贴板的必须是完整值，不是显示的那 8 位
    expect(writeText).toHaveBeenCalledWith(full);
  });

  it("完整编号在 title 与 aria-label 里可见（便于报障时提供）", () => {
    const full = "8e10b205-39d4-4157-b4f5-a647319587c6";
    render(<QaCopyableId id={full} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("title")).toContain(full);
    expect(button.getAttribute("aria-label")).toContain(full);
  });

  it("点击复制不冒泡——所在表格行的展开详情不该被顺带触发", async () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <QaCopyableId id="abcdefgh-1234" />
      </div>,
    );

    await userEvent.click(screen.getByRole("button"));
    expect(writeText).toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("自定义 label 生效", () => {
    render(<QaCopyableId id="abcdefgh-1234" label="任务编号" />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("任务编号");
  });
});

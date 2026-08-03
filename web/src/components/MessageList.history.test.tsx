import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MessageItem } from "@agent/shared";

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1", username: "tester", debugMode: false } }),
}));

vi.mock("@/hooks/useVoicePlayer", () => ({
  useVoicePlayer: () => ({
    activeId: null,
    getState: () => "idle",
    play: vi.fn(),
    togglePause: vi.fn(),
    stop: vi.fn(),
  }),
}));

import { MessageList } from "./MessageList";

const messages: MessageItem[] = [
  { id: "message-1", type: "user", content: "当前消息" },
];

describe("MessageList 历史消息自动加载", () => {
  it("每次滚动触顶只触发一页，离开顶部后可再次触发", () => {
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);
    const scrollContainerRef = createRef<HTMLDivElement>();

    render(
      <MessageList
        messages={messages}
        loading={false}
        hasMoreHistory
        onLoadEarlier={onLoadEarlier}
        scrollContainerRef={scrollContainerRef}
        debugModeOverride={false}
      />,
    );

    const container = scrollContainerRef.current!;
    container.scrollTop = 120;
    fireEvent.scroll(container);
    expect(onLoadEarlier).not.toHaveBeenCalled();

    container.scrollTop = 0;
    fireEvent.scroll(container);
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    container.scrollTop = 20;
    fireEvent.scroll(container);
    container.scrollTop = 0;
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "加载更早消息" })).toBeNull();
  });

  it("长任务跨分页重新分组后仍保持当前视口位置", () => {
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);
    const scrollContainerRef = createRef<HTMLDivElement>();
    const currentLongTask: MessageItem = {
      id: "tool-current",
      type: "tool_use",
      toolName: "Read",
      toolId: "tool-current",
      toolInput: "{}",
      resultReady: true,
    };
    const earlierLongTask: MessageItem = {
      id: "tool-earlier",
      type: "tool_use",
      toolName: "Shell",
      toolId: "tool-earlier",
      toolInput: "{}",
      resultReady: true,
    };
    const { rerender } = render(
      <MessageList
        messages={[currentLongTask]}
        loading={false}
        hasMoreHistory
        onLoadEarlier={onLoadEarlier}
        scrollContainerRef={scrollContainerRef}
        debugModeOverride={false}
      />,
    );

    const container = scrollContainerRef.current!;
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 400,
    });
    container.scrollTop = 0;
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    // 补入旧工具活动后，活动组会以更早消息重新生成 key；用真实新增高度补偿视口。
    scrollHeight = 1640;
    rerender(
      <MessageList
        messages={[earlierLongTask, currentLongTask]}
        loading={false}
        hasMoreHistory
        onLoadEarlier={onLoadEarlier}
        scrollContainerRef={scrollContainerRef}
        debugModeOverride={false}
      />,
    );

    expect(container.scrollTop).toBe(640);
  });

  it("分页进行中不重复触发，并展示非阻塞加载状态", () => {
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);
    const scrollContainerRef = createRef<HTMLDivElement>();

    render(
      <MessageList
        messages={messages}
        loading={false}
        hasMoreHistory
        isLoadingEarlier
        onLoadEarlier={onLoadEarlier}
        scrollContainerRef={scrollContainerRef}
        debugModeOverride={false}
      />,
    );

    const container = scrollContainerRef.current!;
    container.scrollTop = 0;
    fireEvent.scroll(container);

    expect(onLoadEarlier).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("正在加载更早消息");
  });
});

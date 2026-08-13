import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertRuntimeStatusMessage, type MessageItem } from "@agent/shared";
import { useMessages } from "./useMessages";

function createScrollContainer() {
  const writes: number[] = [];
  let scrollTop = 0;
  const element = {
    scrollHeight: 1200,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
      writes.push(value);
    },
  } as unknown as HTMLDivElement;
  return { element, writes };
}

async function flushFrames() {
  // 第一帧提交消息 state，随后 useEffect 再安排自动滚动帧。
  for (let frame = 0; frame < 3; frame += 1) {
    await act(async () => {
      await vi.runAllTimersAsync();
    });
  }
}

describe("useMessages 自动滚动", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    ));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("底部短会话收到重复思考状态时不滚动，新增可见内容后恢复跟随", async () => {
    const { result } = renderHook(() => useMessages());
    await flushFrames();
    const { element, writes } = createScrollContainer();
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = element;

    act(() => {
      upsertRuntimeStatusMessage(result.current, "running", {
        streamId: "stream-1",
        runId: "run-1",
      });
    });
    await flushFrames();
    expect(writes).toContain(element.scrollHeight);

    writes.length = 0;
    const messagesBeforeDuplicate = result.current.messages;
    act(() => {
      upsertRuntimeStatusMessage(result.current, "running", {
        streamId: "stream-1",
        runId: "run-1",
      });
    });
    await flushFrames();

    expect(result.current.messages).toBe(messagesBeforeDuplicate);
    expect(writes).toEqual([]);

    act(() => {
      result.current.addMessage({ type: "text", content: "开始输出" });
    });
    await flushFrames();
    expect(writes).toContain(element.scrollHeight);
  });

  it("长会话查看历史消息时，重复思考状态与新增内容都不强制拉回底部", async () => {
    const { result } = renderHook(() => useMessages());
    await flushFrames();
    const { element, writes } = createScrollContainer();
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = element;
    result.current.isNearBottomRef.current = false;

    const history: MessageItem[] = Array.from({ length: 120 }, (_, index) => ({
      id: `history-${index}`,
      type: index % 2 === 0 ? "user" : "text",
      content: `消息 ${index}`,
    }));
    history.push({
      id: "status",
      type: "runtime_status",
      status: "running",
      content: "正在思考",
      streamId: "stream-long",
      runId: "run-long",
      streaming: true,
      timestamp: 1234,
    });

    act(() => {
      result.current.setMessages(history, { scrollToBottom: false });
    });
    await flushFrames();
    writes.length = 0;

    act(() => {
      upsertRuntimeStatusMessage(result.current, "running", {
        streamId: "stream-long",
        runId: "run-long",
      });
    });
    await flushFrames();
    expect(writes).toEqual([]);

    act(() => {
      result.current.addMessage({ type: "text", content: "流式新内容" });
    });
    await flushFrames();
    expect(writes).toEqual([]);
  });
});

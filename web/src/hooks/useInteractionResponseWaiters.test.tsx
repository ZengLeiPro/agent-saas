import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  send: vi.fn<(payload: unknown) => Promise<boolean>>(async () => true),
}));

vi.mock("@/lib/wsClient", () => ({
  wsClient: { ensureConnectedSend: (payload: unknown) => harness.send(payload) },
}));

import { useInteractionResponseWaiters } from "./useInteractionResponseWaiters";

describe("useInteractionResponseWaiters", () => {
  beforeEach(() => harness.send.mockClear());

  it("仅在服务端确认后完成表单回答", async () => {
    const { result } = renderHook(() => useInteractionResponseWaiters());
    const pending = result.current.respondToInteraction("ask-1", "session-1", { answers: { "继续吗？": "继续" } });

    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({ action: "respond", interactionId: "ask-1" }));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    act(() => result.current.settleInteractionResponse({ type: "respond_ok", interactionId: "ask-1" }));
    await expect(pending).resolves.toBeUndefined();
  });

  it("服务端拒绝后允许重试", async () => {
    const { result } = renderHook(() => useInteractionResponseWaiters());
    const rejected = result.current.respondToInteraction("ask-1", "session-1", { answers: {} });

    act(() => result.current.settleInteractionResponse({ type: "respond_error", interactionId: "ask-1", error: "Run unavailable" }));
    await expect(rejected).rejects.toThrow("Run unavailable");

    const retry = result.current.respondToInteraction("ask-1", "session-1", { answers: {} });
    expect(harness.send).toHaveBeenCalledTimes(2);
    act(() => result.current.settleInteractionResponse({ type: "respond_ok", interactionId: "ask-1" }));
    await expect(retry).resolves.toBeUndefined();
  });
});

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePendingNewSessionTarget } from "./usePendingNewSessionTarget";

const addSessionsToGroup = vi.hoisted(() => vi.fn());

vi.mock("@/lib/groupsApi", () => ({ addSessionsToGroup }));

describe("usePendingNewSessionTarget", () => {
  beforeEach(() => {
    addSessionsToGroup.mockReset();
    addSessionsToGroup.mockResolvedValue({ id: "group-1" });
  });

  it("会话建立后只把它加入一次所选分组", async () => {
    const { result } = renderHook(() => usePendingNewSessionTarget());
    let firstAssignment!: Promise<void>;
    let duplicateAssignment!: Promise<void>;

    act(() => {
      result.current.pendingNewSessionGroupIdRef.current = "group-1";
      firstAssignment = result.current.assignPendingGroup("session-1");
      duplicateAssignment = result.current.assignPendingGroup("session-1");
    });
    await act(async () => firstAssignment);

    expect(duplicateAssignment).toBe(firstAssignment);
    expect(addSessionsToGroup).toHaveBeenCalledWith("group-1", ["session-1"]);
    expect(addSessionsToGroup).toHaveBeenCalledTimes(1);
    expect(result.current.pendingNewSessionGroupIdRef.current).toBeNull();
  });

  it("分组写入短暂失败时重试，成功后才消费待选分组", async () => {
    addSessionsToGroup
      .mockRejectedValueOnce(new Error("owner meta 尚未可见"))
      .mockResolvedValueOnce({ id: "group-1" });
    const { result } = renderHook(() => usePendingNewSessionTarget());

    result.current.pendingNewSessionGroupIdRef.current = "group-1";
    await act(async () => result.current.assignPendingGroup("session-1"));

    expect(addSessionsToGroup).toHaveBeenCalledTimes(2);
    expect(result.current.pendingNewSessionGroupIdRef.current).toBeNull();
  });

  it("重试耗尽后保留待选分组，后续调用仍可继续重试", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    addSessionsToGroup.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => usePendingNewSessionTarget());

    result.current.pendingNewSessionGroupIdRef.current = "group-1";
    await act(async () => result.current.assignPendingGroup("session-1"));

    expect(addSessionsToGroup).toHaveBeenCalledTimes(3);
    expect(result.current.pendingNewSessionGroupIdRef.current).toBe("group-1");

    addSessionsToGroup.mockResolvedValue({ id: "group-1" });
    await act(async () => result.current.assignPendingGroup("session-1"));
    expect(addSessionsToGroup).toHaveBeenCalledTimes(4);
    expect(result.current.pendingNewSessionGroupIdRef.current).toBeNull();
    errorSpy.mockRestore();
  });
});

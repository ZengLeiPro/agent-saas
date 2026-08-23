import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePendingNewSessionTarget } from "./usePendingNewSessionTarget";

const addSessionsToGroup = vi.hoisted(() => vi.fn(async () => ({ id: "group-1" })));

vi.mock("@/lib/groupsApi", () => ({ addSessionsToGroup }));

describe("usePendingNewSessionTarget", () => {
  beforeEach(() => addSessionsToGroup.mockClear());

  it("会话建立后只把它加入一次所选分组", async () => {
    const { result } = renderHook(() => usePendingNewSessionTarget());

    act(() => {
      result.current.pendingNewSessionGroupIdRef.current = "group-1";
      result.current.assignPendingGroup("session-1");
      result.current.assignPendingGroup("session-1");
    });

    await waitFor(() => expect(addSessionsToGroup).toHaveBeenCalledWith("group-1", ["session-1"]));
    expect(addSessionsToGroup).toHaveBeenCalledTimes(1);
    expect(result.current.pendingNewSessionGroupIdRef.current).toBeNull();
  });
});

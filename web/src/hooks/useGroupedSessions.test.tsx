// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGroupedSessions } from "./useGroupedSessions";
import type { ChatSessionIndexItem } from "@/types/sidebar";
import type { ApiSessionGroup } from "@agent/shared/lib/groupsApi";

function session(
  id: string,
  updatedAt: number,
  isRunning = false,
): ChatSessionIndexItem {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    isRunning,
  };
}

function group(id: string, sessionIds: string[]): ApiSessionGroup {
  return {
    id,
    userId: "user-1",
    name: id,
    kind: "manual",
    sessionIds,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("useGroupedSessions", () => {
  it("子会话运行时聚合文件夹运行态，并让文件夹保持在新空闲会话之前", () => {
    const sessions = [
      session("running-in-folder", 100, true),
      session("newer-idle", 200),
    ];

    const { result } = renderHook(() =>
      useGroupedSessions(sessions, "", [group("工作文件夹", ["running-in-folder"])]),
    );

    expect(result.current[0]).toMatchObject({
      type: "group",
      group: {
        groupKey: "工作文件夹",
        isRunning: true,
      },
    });
    expect(result.current[1]).toMatchObject({
      type: "session",
      session: { id: "newer-idle" },
    });
  });

  it("未分组的运行中会话保持在更新时间更晚的空闲会话之前", () => {
    const sessions = [
      session("running", 100, true),
      session("newer-idle", 200),
    ];

    const { result } = renderHook(() => useGroupedSessions(sessions, "", []));

    expect(result.current.map((entry) =>
      entry.type === "session" ? entry.session.id : entry.group.groupKey,
    )).toEqual(["running", "newer-idle"]);
  });
});

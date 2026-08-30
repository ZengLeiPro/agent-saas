import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTranscriptBlock } from "@agent/shared";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false, user: null }),
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

vi.mock("@/lib/sessionShareApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sessionShareApi")>("@/lib/sessionShareApi");
  return { ...actual, fetchPublicSessionShare: vi.fn() };
});

import { SessionSharePage } from "./SessionSharePage";
import {
  fetchPublicSessionShare,
  type PublicSessionShareResponse,
} from "@/lib/sessionShareApi";

beforeAll(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

function todoBlock(id: string, status: "in_progress" | "completed"): ApiTranscriptBlock {
  return {
    id,
    kind: "tool_use",
    title: "TodoWrite",
    defaultOpen: false,
    content: JSON.stringify({
      todos: [{
        id: "share-step",
        kind: "business",
        content: "核验分享步骤",
        status,
        ...(status === "completed" ? {
          outcome: { text: "分享核验完成" },
          detail: [{ verdict: "pass", text: "公开字段完整" }],
          display: [{
            type: "facts",
            title: "核验统计",
            items: [
              { label: "通过", value: "8" },
              { label: "异常", value: "0" },
              { label: "来源", value: "公开快照" },
            ],
          }],
          evidenceRefs: ["receipt:share-step"],
        } : {}),
      }],
    }),
    toolName: "TodoWrite",
    toolId: id,
    runId: "shared-run-1",
    executionStatus: "completed",
    publicActivityOnly: true,
  };
}

function sharedResponse(): PublicSessionShareResponse {
  const blocks: ApiTranscriptBlock[] = [
    {
      id: "prompt-1",
      kind: "prompt",
      title: "用户",
      defaultOpen: false,
      content: "核验公开结果",
    },
    todoBlock("todo-start", "in_progress"),
    {
      id: "read-step",
      kind: "tool_use",
      title: "读取公开数据",
      defaultOpen: false,
      content: "",
      toolName: "Read",
      toolId: "read-step",
      executionStatus: "completed",
      presentation: { title: "读取公开数据" },
      publicActivityOnly: true,
    },
    {
      id: "connector-step",
      kind: "tool_use",
      title: "钉钉 · 写入公开回执",
      defaultOpen: false,
      content: "",
      toolName: "DwsBusiness",
      toolId: "connector-step",
      executionStatus: "completed",
      presentation: {
        title: "钉钉 · 写入公开回执",
        connector: { system: "钉钉", write: true },
      },
      publicActivityOnly: true,
    },
    {
      id: "artifact-step",
      kind: "tool_use",
      title: "交付分享核验报告",
      defaultOpen: false,
      content: "",
      toolName: "Artifact",
      toolId: "artifact-step",
      executionStatus: "completed",
      toolMetadata: {
        artifactAction: "deliver",
        artifactId: "artifact-share-step",
        artifactKind: "file",
        fileName: "分享核验报告.xlsx",
        sizeBytes: 128,
      },
      publicActivityOnly: true,
    },
    todoBlock("todo-done", "completed"),
  ];
  return {
    share: {
      ownerUsername: "用户",
      debugMode: true,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      accessCount: 1,
    },
    detail: {
      sessionId: "shared-session",
      stats: { lines: blocks.length, parsedLines: blocks.length, parseErrors: 0 },
      blocks,
      owner: { userId: "shared-user", username: "用户", realName: "分享用户" },
    },
  };
}

describe("SessionSharePage 业务步骤只读详情", () => {
  beforeEach(() => {
    vi.mocked(fetchPublicSessionShare).mockResolvedValue(sharedResponse());
  });

  it("点击主卡步骤后通过只读 Sheet 查看结果、过程、依据与 Artifact", async () => {
    render(<SessionSharePage token="share-token" />);

    const stepRow = await screen.findByRole("button", { name: /核验分享步骤/ });
    expect(fetchPublicSessionShare).toHaveBeenCalledWith("share-token");
    expect(stepRow.getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByText("分享核验完成")).toBeNull();
    expect(screen.queryByText("分享核验报告.xlsx")).toBeNull();

    fireEvent.click(stepRow);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("分享核验完成")).toBeTruthy();
    expect(within(sheet).getByText("公开字段完整")).toBeTruthy();
    expect(within(sheet).getByText("核验统计")).toBeTruthy();
    expect(within(sheet).getByText("分享核验报告.xlsx")).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("tab", { name: "过程" }));
    expect(within(sheet).getByText(/读取公开数据/)).toBeTruthy();
    expect(within(sheet).getByText(/写入公开回执/)).toBeTruthy();
    expect(sheet.querySelector("[data-business-step-process]")?.childElementCount).toBeGreaterThanOrEqual(2);
    fireEvent.click(within(sheet).getByRole("tab", { name: "依据" }));
    expect(within(sheet).getByText("receipt:share-step")).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(stepRow));
    expect(stepRow.getAttribute("aria-selected")).toBe("false");
  });
});

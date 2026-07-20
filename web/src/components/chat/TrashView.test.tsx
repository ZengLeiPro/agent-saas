import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { TrashView } from "./TrashView";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TrashView", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("在设置页标题栏显示全部清空，并经确认后批量删除", async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse({
        sessions: [
          { sessionId: "session-1", title: "会话一", updatedAtMs: 1, deletedAt: "2026-07-20T12:00:00.000Z" },
          { sessionId: "session-2", title: "会话二", updatedAtMs: 2, deletedAt: "2026-07-20T13:00:00.000Z" },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, deletedCount: 2 }));
    const onPreviewSession = vi.fn();

    render(
      <TrashView
        onClose={vi.fn()}
        onPreviewSession={onPreviewSession}
        activePreviewId="session-1"
        showHeader={false}
      />,
    );

    expect(await screen.findByText("会话一")).toBeTruthy();
    const clearButton = screen.getByRole("button", { name: "全部清空" });
    fireEvent.click(clearButton);

    expect(screen.getByRole("dialog", { name: "清空回收站" })).toBeTruthy();
    expect(screen.getByText("确定要永久删除回收站中的 2 个会话吗？此操作不可恢复。")).toBeTruthy();
    expect(authFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "确认清空" }));
    await waitFor(() => {
      expect(authFetch).toHaveBeenNthCalledWith(2, "/api/sessions/trash", { method: "DELETE" });
      expect(screen.getByText("回收站为空")).toBeTruthy();
    });
    expect(onPreviewSession).toHaveBeenCalledWith(null);
  });

  it("取消确认时不发起清空请求", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(jsonResponse({
      sessions: [{ sessionId: "session-1", title: "会话一", updatedAtMs: 1 }],
    }));
    render(<TrashView onClose={vi.fn()} showHeader={false} />);

    expect(await screen.findByText("会话一")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部清空" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "清空回收站" })).toBeNull();
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "./types";
import { RunHistory } from "./RunHistory";
import { authFetch } from "@/lib/authFetch";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { debugMode: true } }),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function entry(runId: string, startedAtMs: number): CronRunLogEntry {
  return {
    runId,
    startedAtMs,
    endedAtMs: startedAtMs + 1_000,
    jobId: "job-1",
    jobName: "定时任务",
    status: "ok",
    durationMs: 1_000,
    hasTranscript: true,
  };
}

function detailsResponse(run: CronRunLogEntry, content: string): Response {
  return new Response(
    JSON.stringify({
      run,
      transcript: {},
      blocks: [
        {
          id: `${run.runId}-block`,
          kind: "text",
          title: `${run.runId} 标题`,
          defaultOpen: true,
          content,
        },
      ],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("RunHistory 详情请求隔离", () => {
  beforeEach(() => vi.clearAllMocks());

  it("展示尝试次数与重试来源，避免把重试看成重复首发", () => {
    const first = entry("run-first", 1_700_000_000_000);
    const retry = {
      ...entry("run-retry", 1_700_000_100_000),
      trigger: "retry" as const,
      attempt: 2,
      retryOf: first.runId,
      parentRunId: first.runId,
    };

    render(
      <RunHistory
        active
        entries={[retry, first]}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByText("第 2 次尝试")).toBeTruthy();
    expect(screen.getByText("第 1 次尝试")).toBeTruthy();
    const retryBadge = screen.getByText("重试");
    expect(retryBadge.getAttribute("title")).toBe(`重试来源：${first.runId}`);
  });

  it("旧运行详情响应不会覆盖新选择，视图恢复后复用已加载详情", async () => {
    const first = entry("run-1", 1_700_000_000_000);
    const second = entry("run-2", 1_700_000_100_000);
    const firstRequest = deferred<Response>();
    const secondRequest = deferred<Response>();
    vi.mocked(authFetch)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    const { rerender } = render(
      <RunHistory
        active
        entries={[first, second]}
        loading={false}
        error={null}
      />,
    );
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]!);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(rows[2]!);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));

    secondRequest.resolve(detailsResponse(second, "第二条详情"));
    expect(await screen.findByText("第二条详情")).toBeTruthy();
    firstRequest.resolve(detailsResponse(first, "第一条旧详情"));
    await firstRequest.promise;
    expect(screen.queryByText("第一条旧详情")).toBeNull();

    rerender(
      <RunHistory
        active={false}
        entries={[first, second]}
        loading={false}
        error={null}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rerender(
      <RunHistory
        active
        entries={[first, second]}
        loading={false}
        error={null}
      />,
    );
    expect(await screen.findByText("第二条详情")).toBeTruthy();
    expect(authFetch).toHaveBeenCalledTimes(2);
  });
});

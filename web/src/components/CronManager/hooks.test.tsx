import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronServiceStatus } from "./types";

const mocked = vi.hoisted(() => ({
  authFetch: vi.fn(),
  registerRefresh: vi.fn(),
  unregisterRefresh: vi.fn(),
}));

vi.mock("@/lib/authFetch", () => ({
  authFetch: (url: string, init?: RequestInit) => mocked.authFetch(url, init),
}));

vi.mock("@/lib/refreshBus", () => ({
  registerRefresh: (key: string, refresh: () => Promise<void>) => mocked.registerRefresh(key, refresh),
  unregisterRefresh: (key: string) => mocked.unregisterRefresh(key),
}));

import {
  useCronJobs,
  useCronStatus,
  useDingtalkSessions,
  useModelList,
  useRunHistory,
} from "./hooks";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function status(jobCount: number): CronServiceStatus {
  return { enabled: true, jobCount, enabledJobCount: jobCount };
}

function job(id: string, nextRunAtMs: number): CronJob {
  return {
    id,
    name: `任务 ${id}`,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: id },
    createdAtMs: 1,
    updatedAtMs: 1,
    state: { nextRunAtMs },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Cron hooks refresh consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("挂载时分别拉取最新 status/jobs，且新实例不会复用旧实例数据", async () => {
    let statusRequest = 0;
    mocked.authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/cron/status") return jsonResponse(status(++statusRequest));
      if (url === "/api/cron/jobs?includeDisabled=true") {
        return jsonResponse({ jobs: [job(`j-${statusRequest}`, 20), job("first", 10)] });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const first = renderHook(() => ({ status: useCronStatus(), jobs: useCronJobs() }));
    await waitFor(() => expect(first.result.current.status.status?.jobCount).toBe(1));
    await waitFor(() => expect(first.result.current.jobs.jobs.map((item) => item.id)).toEqual(["first", "j-1"]));
    first.unmount();

    const second = renderHook(() => useCronStatus());
    await waitFor(() => expect(second.result.current.status?.jobCount).toBe(2));

    expect(mocked.authFetch.mock.calls.filter(([url]) => url === "/api/cron/status")).toHaveLength(2);
    expect(mocked.authFetch).toHaveBeenCalledWith("/api/cron/jobs?includeDisabled=true", undefined);
    expect(mocked.registerRefresh).toHaveBeenCalledWith(expect.stringMatching(/^cronStatus:/), expect.any(Function));
    expect(mocked.registerRefresh).toHaveBeenCalledWith(expect.stringMatching(/^cronJobs:/), expect.any(Function));
  });

  it("并存实例使用独立 refreshBus key，卸载一方不会注销另一方", async () => {
    mocked.authFetch.mockImplementation(async () => jsonResponse(status(1)));
    const first = renderHook(() => useCronStatus());
    const second = renderHook(() => useCronStatus());
    await waitFor(() => expect(first.result.current.status?.jobCount).toBe(1));
    await waitFor(() => expect(second.result.current.status?.jobCount).toBe(1));

    const keys = mocked.registerRefresh.mock.calls
      .map(([key]) => key as string)
      .filter((key) => key.startsWith("cronStatus:"));
    expect(new Set(keys).size).toBe(2);

    first.unmount();
    expect(mocked.unregisterRefresh).toHaveBeenCalledWith(keys[0]);
    expect(mocked.unregisterRefresh).not.toHaveBeenCalledWith(keys[1]);
    second.unmount();
  });

  it("钉钉会话和模型数据不会跨 hook 实例复用模块缓存", async () => {
    let dingtalkRequests = 0;
    let modelRequests = 0;
    mocked.authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/dingtalk/sessions") {
        dingtalkRequests += 1;
        return jsonResponse({ sessions: [{ conversationId: `c-${dingtalkRequests}` }] });
      }
      if (url === "/api/models") {
        modelRequests += 1;
        return jsonResponse({ groups: [] });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const first = renderHook(() => ({ dingtalk: useDingtalkSessions(), models: useModelList() }));
    await waitFor(() => expect(first.result.current.dingtalk.sessions).toHaveLength(1));
    await waitFor(() => expect(first.result.current.models).not.toBeNull());
    first.unmount();

    const second = renderHook(() => ({ dingtalk: useDingtalkSessions(), models: useModelList() }));
    await waitFor(() => expect(second.result.current.dingtalk.sessions[0]?.conversationId).toBe("c-2"));
    await waitFor(() => expect(second.result.current.models).not.toBeNull());
    expect(dingtalkRequests).toBe(2);
    expect(modelRequests).toBe(2);
    second.unmount();
  });

  it("切换任务时迟到的旧运行历史不会覆盖当前任务", async () => {
    const oldHistory = deferred<Response>();
    mocked.authFetch.mockImplementation((url: string) => {
      if (url.includes("/jobs/old/runs")) return oldHistory.promise;
      if (url.includes("/jobs/new/runs")) {
        return Promise.resolve(jsonResponse({
          entries: [{
            runId: "run-new",
            startedAtMs: 1,
            endedAtMs: 2,
            jobId: "new",
            jobName: "new",
            status: "ok",
            durationMs: 1,
          }],
        }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { result, rerender } = renderHook(
      ({ jobId }: { jobId: string }) => useRunHistory(jobId),
      { initialProps: { jobId: "old" } },
    );
    rerender({ jobId: "new" });
    await waitFor(() => expect(result.current.entries[0]?.jobId).toBe("new"));

    await act(async () => {
      oldHistory.resolve(jsonResponse({
        entries: [{
          runId: "run-old",
          startedAtMs: 1,
          endedAtMs: 2,
          jobId: "old",
          jobName: "old",
          status: "ok",
          durationMs: 1,
        }],
      }));
      await oldHistory.promise;
    });
    expect(result.current.entries[0]?.jobId).toBe("new");
  });

  it("窗口 focus 或 document 从隐藏变为 visible 时后台刷新", async () => {
    let requestCount = 0;
    mocked.authFetch.mockImplementation(async () => jsonResponse(status(++requestCount)));

    const { result } = renderHook(() => useCronStatus());
    await waitFor(() => expect(result.current.status?.jobCount).toBe(1));

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.status?.jobCount).toBe(2));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocked.authFetch).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current.status?.jobCount).toBe(3));
  });

  it("同一 hook 实例的并发 refresh 合并为同一个请求", async () => {
    mocked.authFetch.mockResolvedValueOnce(jsonResponse(status(1)));
    const { result } = renderHook(() => useCronStatus());
    await waitFor(() => expect(result.current.status?.jobCount).toBe(1));

    const pendingResponse = deferred<Response>();
    mocked.authFetch.mockImplementationOnce(() => pendingResponse.promise);

    let firstRefresh!: Promise<void>;
    let secondRefresh!: Promise<void>;
    act(() => {
      firstRefresh = result.current.refresh();
      secondRefresh = result.current.refresh();
    });

    expect(firstRefresh).toBe(secondRefresh);
    expect(mocked.authFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingResponse.resolve(jsonResponse(status(2)));
      await firstRefresh;
    });
    expect(result.current.status?.jobCount).toBe(2);
  });

  it("变更完成后不会复用变更前仍在飞行的旧列表响应", async () => {
    const staleList = deferred<Response>();
    let listRequests = 0;
    mocked.authFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/cron/jobs?includeDisabled=true") {
        listRequests += 1;
        if (listRequests === 1) return Promise.resolve(jsonResponse({ jobs: [job("old", 10)] }));
        if (listRequests === 2) return staleList.promise;
        return Promise.resolve(jsonResponse({ jobs: [job("new", 20)] }));
      }
      if (url === "/api/cron/jobs" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const { result } = renderHook(() => useCronJobs());
    await waitFor(() => expect(result.current.jobs.map((item) => item.id)).toEqual(["old"]));

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(listRequests).toBe(2));

    let addPromise!: Promise<void>;
    act(() => {
      addPromise = result.current.addJob({
        name: "new",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", text: "new" },
      });
    });

    await act(async () => {
      staleList.resolve(jsonResponse({ jobs: [job("old", 10)] }));
      await addPromise;
    });

    expect(listRequests).toBe(3);
    expect(result.current.jobs.map((item) => item.id)).toEqual(["new"]);
  });

  it("请求完成前卸载时不再写入任何 hook state", async () => {
    const pendingResponse = deferred<Response>();
    mocked.authFetch.mockImplementationOnce(() => pendingResponse.promise);

    const { result, unmount } = renderHook(() => useCronStatus());
    expect(mocked.authFetch).toHaveBeenCalledTimes(1);
    const refreshPromise = result.current.refresh();

    unmount();
    await act(async () => {
      pendingResponse.resolve(jsonResponse(status(1)));
      await refreshPromise;
    });

    expect(result.current.status).toBeNull();
    expect(mocked.unregisterRefresh).toHaveBeenCalledWith(expect.stringMatching(/^cronStatus:/));
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskBoardIntegrationSource } from "@agent/shared/types/taskboard";
import * as api from "./api";
import { useIntegrationSources } from "./IntegrationSources";

vi.mock("./api", () => ({ fetchIntegrationSources: vi.fn() }));

const fetchIntegrationSources = vi.mocked(api.fetchIntegrationSources);

function source(id: string, integrationTaskId: string): TaskBoardIntegrationSource {
  return {
    id, integrationTaskId, deliveryTaskId: `delivery-${id}`, repositoryId: "repo-1",
    providerPullRequestId: `pr-${id}`,
    order: 0, state: "needs_human",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("useIntegrationSources request isolation", () => {
  beforeEach(() => fetchIntegrationSources.mockReset());

  it("ignores an older task response that arrives after the selected task changes", async () => {
    const first = deferred<TaskBoardIntegrationSource[]>();
    const second = deferred<TaskBoardIntegrationSource[]>();
    fetchIntegrationSources.mockImplementation((taskId) => taskId === "integration-a" ? first.promise : second.promise);
    const { result, rerender } = renderHook(
      ({ taskId }) => useIntegrationSources(taskId),
      { initialProps: { taskId: "integration-a" } },
    );

    rerender({ taskId: "integration-b" });
    second.resolve([source("b", "integration-b")]);
    await waitFor(() => expect(result.current.sources.map((item) => item.id)).toEqual(["b"]));
    first.resolve([source("a", "integration-a")]);
    await Promise.resolve();
    expect(result.current.sources.map((item) => item.id)).toEqual(["b"]);
  });

  it("retains stale source counts when a refresh for the same task fails", async () => {
    fetchIntegrationSources.mockResolvedValueOnce([source("a", "integration-a")]).mockRejectedValueOnce(new Error("refresh failed"));
    const { result } = renderHook(() => useIntegrationSources("integration-a"));
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBe("refresh failed"));
    expect(result.current.sources.map((item) => item.id)).toEqual(["a"]);
  });

  it("clears the previous task data when the next task load fails", async () => {
    fetchIntegrationSources.mockResolvedValueOnce([source("a", "integration-a")]);
    const { result, rerender } = renderHook(
      ({ taskId }) => useIntegrationSources(taskId),
      { initialProps: { taskId: "integration-a" } },
    );
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    fetchIntegrationSources.mockRejectedValueOnce(new Error("B load failed"));
    rerender({ taskId: "integration-b" });
    await waitFor(() => expect(result.current.error).toBe("B load failed"));
    expect(result.current.sources).toEqual([]);
  });
});

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardIntegrationCandidateDetails, TaskBoardTask } from "@agent/shared/types/taskboard";
import * as api from "./api";
import { IntegrationCandidateDetails, IntegrationTaskDetails, useIntegrationCandidate } from "./IntegrationCandidate";

vi.mock("./api", () => ({ fetchIntegrationCandidate: vi.fn() }));
const fetchIntegrationCandidate = vi.mocked(api.fetchIntegrationCandidate);

const details: TaskBoardIntegrationCandidateDetails = {
  candidate: {
    id: "candidate-1", integrationTaskId: "task-v3", repositoryId: "repo-1", baseBranch: "main",
    branch: "integration/candidate-1", providerPullRequestId: "42", state: "in_review",
    currentRevision: 2, workRound: 1, version: 4, workflowEpoch: "workflow-1", laneEpoch: "lane-1",
    policyRevision: "policy-2", mergeMethod: "squash", policySnapshot: {}, sourceSetDigest: "sha256:sources",
    approvedRevision: 1, createdAt: "2026-08-19T01:00:00.000Z", updatedAt: "2026-08-19T02:00:00.000Z",
  },
  revisions: [{
    candidateId: "candidate-1", revision: 2, digestVersion: 1, baseOid: "aaaaaaaaaaaaaaaa",
    headOid: "bbbbbbbbbbbbbbbb", treeOid: "cccccccccccccccc", sourceSetDigest: "sha256:sources",
    subjectDigest: "sha256:subject", policySnapshotDigest: "sha256:policy", policyRevision: "policy-2",
    mergeMethod: "squash", workRound: 1, workExecutionId: "work-2", reviewExecutionId: "review-2",
    createdAt: "2026-08-19T02:00:00.000Z",
  }],
  sourceSnapshots: [],
  lastRefreshedAt: "2026-08-19T02:03:00.000Z",
};

describe("Integration v3 Candidate UI", () => {
  beforeEach(() => fetchIntegrationCandidate.mockReset());

  it("展示 Candidate 身份、当前 subject 与 Work/Review 历史，不展示逐来源已合并", async () => {
    fetchIntegrationCandidate.mockResolvedValue(details);
    render(<IntegrationCandidateDetails taskId="task-v3" />);

    expect(await screen.findByText("integration/candidate-1")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("main @ aaaaaaaaaaaa")).toBeTruthy();
    expect(screen.getByText("bbbbbbbbbbbb / cccccccccccc")).toBeTruthy();
    expect(screen.getByText("sha256:sources")).toBeTruthy();
    expect(screen.getByText(/R2 · round 1/)).toBeTruthy();
    expect(screen.getByText("review-2")).toBeTruthy();
    expect(screen.getByText(/last refreshed/)).toBeTruthy();
    expect(screen.queryByText(/\d+\/\d+ 已合并/)).toBeNull();
  });

  it("TaskDetail 的 v3 容器自行加载并渲染 Candidate，而非 v2 来源详情", async () => {
    fetchIntegrationCandidate.mockResolvedValue(details);
    render(
      <IntegrationTaskDetails
        task={{ id: "task-v3", kind: "integration", workflowVersion: 3 } as TaskBoardTask}
        active
        sourceState={{ sources: [], loading: false, error: null, refresh: vi.fn() }}
        selectedSourceIds={new Set()}
        setSelectedSourceIds={vi.fn()}
        sourceSelectionEnabled={false}
      />,
    );

    expect(await screen.findByText("integration/candidate-1")).toBeTruthy();
    expect(fetchIntegrationCandidate).toHaveBeenCalledWith("task-v3");
    expect(screen.queryByRole("region", { name: "集成来源" })).toBeNull();
  });

  it.each([
    [undefined, "已合并 · cleanup 待处理"],
    [{ outcome: "failed", requestStatus: "failed", reason: "branch deletion failed", updatedAt: details.lastRefreshedAt }, "已合并 · cleanup 失败：branch deletion failed"],
    [{ outcome: "skipped", requestStatus: "completed", reason: "skipped-by-policy: disabled", updatedAt: details.lastRefreshedAt }, "已合并 · cleanup 已跳过：skipped-by-policy: disabled"],
    [{ outcome: "completed", requestStatus: "completed", updatedAt: details.lastRefreshedAt }, "已合并 · cleanup 已完成"],
  ] as const)("区分 merged 后的 cleanup 状态 %#", async (cleanup, expected) => {
    fetchIntegrationCandidate.mockResolvedValue({
      ...details,
      candidate: { ...details.candidate, state: "merged" },
      ...(cleanup ? { cleanup } : {}),
    });
    render(<IntegrationCandidateDetails taskId="task-v3" />);
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it("cleanup 永久失败时提供人工重排入口", async () => {
    fetchIntegrationCandidate.mockResolvedValue({
      ...details,
      candidate: { ...details.candidate, state: "merged" },
      cleanup: { outcome: "failed", requestStatus: "failed", reason: "branch deletion failed", updatedAt: details.lastRefreshedAt },
    });
    render(<IntegrationCandidateDetails taskId="task-v3" />);
    expect(await screen.findByRole("button", { name: "Maintainer 重新排队 cleanup" })).toBeTruthy();
  });

  it("明确展示永久 worker_error", async () => {
    fetchIntegrationCandidate.mockResolvedValue({
      ...details,
      worker: { status: "failed", checkpoint: {}, error: "provider permission denied" },
    });
    render(<IntegrationCandidateDetails taskId="task-v3" />);
    expect(await screen.findByText("worker_error：provider permission denied")).toBeTruthy();
  });

  it("同一 Candidate 刷新失败时保留 stale 投影", async () => {
    fetchIntegrationCandidate.mockResolvedValueOnce(details).mockRejectedValueOnce(new Error("temporary outage"));
    const { result } = renderHook(() => useIntegrationCandidate("task-v3"));
    await waitFor(() => expect(result.current.details).toEqual(details));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBe("temporary outage"));
    expect(result.current.details).toEqual(details);
  });
});

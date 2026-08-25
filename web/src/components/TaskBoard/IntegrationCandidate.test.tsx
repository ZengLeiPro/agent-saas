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
    headOid: "bbbbbbbbbbbbbbbb", treeOid: "cccccccccccccccc", compositionComplete: true, sourceSetDigest: "sha256:sources",
    subjectDigest: "sha256:subject", policySnapshotDigest: "sha256:policy", policyRevision: "policy-2",
    mergeMethod: "squash", workRound: 1, workExecutionId: "work-2", reviewExecutionId: "review-2",
    createdAt: "2026-08-19T02:00:00.000Z",
  }],
  sourceSnapshots: [],
  lastRefreshedAt: "2026-08-19T02:03:00.000Z",
};

describe("Integration Agent UI", () => {
  beforeEach(() => fetchIntegrationCandidate.mockReset());

  it("只展示 Agent 进展与 PR，不泄露 Candidate/revision/source-set 历史", async () => {
    fetchIntegrationCandidate.mockResolvedValue(details);
    render(<IntegrationCandidateDetails taskId="task-v3" />);

    expect(await screen.findByText("Integration Agent")).toBeTruthy();
    expect(screen.getByText("integration/candidate-1")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("正在独立复核")).toBeTruthy();
    expect(screen.getByText(/等待当前 PR head 的独立 Review/)).toBeTruthy();
    expect(screen.queryByText(/source-set/)).toBeNull();
    expect(screen.queryByText(/Work 历史/)).toBeNull();
    expect(screen.queryByText(/revision/)).toBeNull();
  });

  it("TaskDetail 的 v3 容器自行加载 Agent 进展，而非 v2 来源详情", async () => {
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

    expect(await screen.findByText("Integration Agent")).toBeTruthy();
    expect(fetchIntegrationCandidate).toHaveBeenCalledWith("task-v3");
    expect(screen.queryByRole("region", { name: "集成来源" })).toBeNull();
  });

  it("只在永久失败时呈现人工处理与重新排队入口", async () => {
    fetchIntegrationCandidate.mockResolvedValue({
      ...details,
      worker: { status: "failed", checkpoint: {}, error: "provider permission denied" },
    });
    render(<IntegrationCandidateDetails taskId="task-v3" />);
    expect(await screen.findByText(/需要人工：provider permission denied/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maintainer 重新排队" })).toBeTruthy();
  });

  it("同一 Agent 刷新失败时保留上次投影", async () => {
    fetchIntegrationCandidate.mockResolvedValueOnce(details).mockRejectedValueOnce(new Error("temporary outage"));
    const { result } = renderHook(() => useIntegrationCandidate("task-v3"));
    await waitFor(() => expect(result.current.details).toEqual(details));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBe("temporary outage"));
    expect(result.current.details).toEqual(details);
  });
});

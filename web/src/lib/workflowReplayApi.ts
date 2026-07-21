import {
  customerWorkflowReplayResponseSchema,
  type CustomerWorkflowReplayResponse,
} from "@agent/shared";

import { apiUrl } from "./apiBase";

export type WorkflowReplayResponse = CustomerWorkflowReplayResponse;

export type WorkflowReplayReference =
  | { kind: "replayId"; value: string }
  | { kind: "token"; value: string };

export async function fetchPublicWorkflowReplay(
  reference: WorkflowReplayReference,
): Promise<WorkflowReplayResponse> {
  const path = reference.kind === "replayId"
    ? `/api/share/workflow-replays/${encodeURIComponent(reference.value)}`
    : `/api/share/workflow-demos/${encodeURIComponent(reference.value)}`;
  const response = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(response.status === 404 ? "这条工作流回放不存在或尚未公开" : "工作流回放暂时不可用");
  }
  const parsed = customerWorkflowReplayResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("工作流回放未通过公开数据校验");
  return parsed.data;
}

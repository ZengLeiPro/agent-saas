import type { WorkflowDemoDispatchMetadata } from "@agent/shared";
import { z } from "zod";

import { authFetch } from "./authFetch";

const startWorkflowDemoResponseSchema = z.object({
  dispatchMetadata: z.object({
    workflowDemo: z.object({
      runId: z.string().uuid(),
      eventId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/),
    }).strict(),
  }).strict(),
  awaitingExternal: z.literal(false),
}).passthrough();

export async function startWorkflowDemo(
  catalogScenarioId: string,
  idempotencyKey: string,
): Promise<WorkflowDemoDispatchMetadata["workflowDemo"]> {
  const response = await authFetch(
    `/api/workflow-demos/catalog/${encodeURIComponent(catalogScenarioId)}/runs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error(response.status === 403
      ? "当前账号不能运行这条隔离演示"
      : "隔离演示启动失败，请稍后重试");
  }
  const parsed = startWorkflowDemoResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("隔离演示没有返回可执行的第一步");
  return parsed.data.dispatchMetadata.workflowDemo;
}

/**
 * 仅用于“run 已创建、但首条 WS 消息未获服务端 ACK”的启动失败路径。
 * 服务端只会把尚未绑定 Runtime 会话的本人 run 标记失败，不会撤销已执行动作。
 */
export async function abandonWorkflowDemoLaunch(runId: string): Promise<void> {
  const response = await authFetch(
    `/api/workflow-demos/runs/${encodeURIComponent(runId)}/launch`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 409 && response.status !== 404) {
    throw new Error("隔离演示启动状态回收失败");
  }
}

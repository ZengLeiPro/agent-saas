import type { MessageItem } from "@/components/types";

export interface PendingInteraction {
  interactionId: string;
  type: "ask_user" | "permission_request" | "approval";
  version: number;
  order: number;
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  toolName?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  planContent?: string;
}

export function recordPerformanceMeasure(name: string, start: number, end: number): void {
  try {
    performance.measure(name, { start, end });
  } catch {
    // 老浏览器或测试环境不支持 PerformanceMeasureOptions 时静默跳过。
  }
}

export function appendPendingInteractions(
  messages: MessageItem[],
  pendingList: PendingInteraction[],
): MessageItem[] {
  const next = [...messages];
  const existingIds = new Set(
    next
      .filter((message) => "interactionId" in message && message.interactionId)
      .map((message) => (message as { interactionId: string }).interactionId),
  );
  const pendingRuntimeStatus = pendingList.some((pending) => pending.type === "permission_request")
    ? { status: "waiting_approval" as const, content: "待处理" }
    : pendingList.some((pending) => pending.type === "ask_user")
      ? { status: "waiting_user" as const, content: "待补充" }
      : null;
  if (pendingRuntimeStatus) {
    let runtimeIndex = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].type === "runtime_status") {
        runtimeIndex = i;
        break;
      }
    }
    if (runtimeIndex >= 0) {
      next[runtimeIndex] = { ...next[runtimeIndex], ...pendingRuntimeStatus, streaming: true } as MessageItem;
    } else {
      next.push({
        id: `pending-runtime-${pendingRuntimeStatus.status}`,
        type: "runtime_status",
        ...pendingRuntimeStatus,
        streaming: true,
      });
    }
  }

  const planLabels: Record<string, { name: string; fallback: string }> = {
    EnterPlanMode: {
      name: "进入规划模式",
      fallback: "Agent 请求进入规划模式，将在只读模式下探索代码库并设计实现方案。",
    },
    ExitPlanMode: {
      name: "规划方案审批",
      fallback: "Agent 已完成方案规划，请审阅后决定是否批准执行。",
    },
  };

  for (const pending of pendingList) {
    if (existingIds.has(pending.interactionId)) continue;
    if (pending.type === "ask_user" && pending.questions) {
      next.push({
        id: `pending-${pending.interactionId}`,
        type: "ask_user",
        interactionId: pending.interactionId,
        interactionVersion: pending.version,
        interactionOrder: pending.order,
        questions: pending.questions,
        status: "pending",
      });
    } else if ((pending.type === "permission_request" || pending.type === "approval") && pending.toolName) {
      const label = planLabels[pending.toolName] ?? {
        name: pending.toolName,
        fallback: "",
      };
      next.push({
        id: `pending-${pending.interactionId}`,
        type: "permission_request",
        interactionId: pending.interactionId,
        interactionVersion: pending.version,
        interactionOrder: pending.order,
        toolName: pending.displayName || label.name,
        toolInput:
          pending.planContent ||
          (pending.toolInput
            ? JSON.stringify(pending.toolInput, null, 2)
            : label.fallback),
        status: "pending",
      });
    }
  }
  return next;
}

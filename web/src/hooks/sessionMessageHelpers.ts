import type { MessageItem } from "@/components/types";
import { projectPendingInteractionSnapshot } from "@agent/shared";

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
  sessionId = "",
  resolvedInteractionIds?: ReadonlySet<string>,
  preservePendingIds?: ReadonlySet<string>,
): MessageItem[] {
  return projectPendingInteractionSnapshot(messages, pendingList, sessionId, resolvedInteractionIds, preservePendingIds);
}

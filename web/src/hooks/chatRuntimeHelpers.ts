import type { ApiSessionDetail } from "@/lib/sessionsApi";
import { wsClient, type WsResumeMessage } from "@/lib/wsClient";

export type LastRunState = NonNullable<ApiSessionDetail["lastRunState"]>;
export type TerminalRuntimeStatus = "idle" | "completed" | "failed" | "cancelled" | "orphaned";

const ACTIVE_RUNTIME_STATUSES = new Set<string>([
  "busy",
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
  "waiting_hand",
]);

const TERMINAL_RUNTIME_STATUSES = new Set<string>([
  "idle",
  "completed",
  "failed",
  "cancelled",
  "orphaned",
]);

export function isActiveRuntimeStatus(status: string | undefined): boolean {
  return !!status && ACTIVE_RUNTIME_STATUSES.has(status);
}

export function isTerminalRuntimeStatus(status: string | undefined): status is TerminalRuntimeStatus {
  return !!status && TERMINAL_RUNTIME_STATUSES.has(status);
}

export function runtimeStatusFromSessionStatus(
  status: string,
): "queued" | "running" | "waiting_hand" | "waiting_approval" | "waiting_user" | null {
  switch (status) {
    case "queued":
      return "queued";
    case "busy":
    case "running":
      return "running";
    case "waiting_hand":
      return "waiting_hand";
    case "waiting_approval":
      return "waiting_approval";
    case "waiting_user":
      return "waiting_user";
    default:
      return null;
  }
}

/** Deduplicate reconnect resumes emitted by this hook's two connection listeners. */
const RESUME_DEDUP_MS = 2000;
let lastResumeSessionId = "";
let lastResumeAt = 0;

export function sendResumeDeduped(payload: WsResumeMessage): Promise<boolean> {
  const now = Date.now();
  if (lastResumeSessionId === payload.sessionId && now - lastResumeAt < RESUME_DEDUP_MS) {
    return Promise.resolve(true);
  }
  lastResumeSessionId = payload.sessionId;
  lastResumeAt = now;
  return wsClient.ensureConnectedSend(payload);
}

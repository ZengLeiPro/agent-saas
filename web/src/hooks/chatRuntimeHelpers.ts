import type { ApiSessionDetail } from "@/lib/sessionsApi";
import { authFetch } from "@/lib/authFetch";
import type { SessionRuntimeStatus } from "@agent/shared";
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

export type StreamStatusSnapshot = {
  active: boolean;
  streamId?: string;
  runId?: string;
  status?: string;
};

export async function fetchSessionStreamStatus(sessionId: string): Promise<StreamStatusSnapshot | null> {
  try {
    const response = await authFetch(`/api/sessions/${sessionId}/stream-status`);
    return response.ok ? response.json() as Promise<StreamStatusSnapshot> : null;
  } catch {
    return null;
  }
}

export function activeRuntimePatchFromStreamStatus(snapshot: StreamStatusSnapshot) {
  return {
    status: isActiveRuntimeStatus(snapshot.status) ? snapshot.status as SessionRuntimeStatus : 'running' as const,
    ...(snapshot.streamId ? { streamId: snapshot.streamId } : {}),
    ...(snapshot.runId ? { runId: snapshot.runId } : {}),
  };
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

let serverDrainReconnect: Promise<void> | null = null;

/** A draining instance keeps existing sockets alive, so move retries onto a fresh connection. */
export function reconnectAfterServerDrain(): void {
  if (serverDrainReconnect) return;
  serverDrainReconnect = wsClient.forceReconnect()
    .catch(() => {})
    .finally(() => { serverDrainReconnect = null; });
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

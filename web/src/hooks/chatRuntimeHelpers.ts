import type { ApiSessionDetail } from "@/lib/sessionsApi";
import { authFetch } from "@/lib/authFetch";
import type { RunLiveness, SessionRuntimeStatus } from "@agent/shared";
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
  liveness?: RunLiveness;
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

/** Session-less done must match the current binding instead of tearing down an unrelated active run. */
export function sessionlessDoneBelongsToRuntime(
  event: { sessionId?: string; streamId?: string; runId?: string; client_msg_id?: string },
  binding: { streamId?: string | null; runId?: string | null; clientMsgId?: string },
): boolean {
  if (event.sessionId) return true;
  const hasCorrelation = Boolean(event.streamId || event.runId || event.client_msg_id);
  if (!hasCorrelation) return true;
  return Boolean((event.streamId && event.streamId === binding.streamId)
    || (event.runId && event.runId === binding.runId)
    || (event.client_msg_id && event.client_msg_id === binding.clientMsgId));
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

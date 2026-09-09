import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { ApiSessionListItem, BoundaryIdentity } from '@agent/shared';
import { authFetch } from '@/lib/authFetch';
import {
  applySessionAgentTargetIdentity,
  needsSessionAgentTargetSync,
  parseSessionAgentTargetIdentity,
  SESSION_BINDING_SYNC_FAILED,
} from '@/lib/sessionAgentTargetIdentity';

const MAX_CONCURRENT_IDENTITY_READS = 4;
const RETRY_DELAYS_MS = [200, 600];

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * WS session/session_updated/replay can contain only a session ID. Resolve those placeholders
 * through detail (persisted meta), not the asynchronously updated session-list projection.
 * This request never loads messages, changes the active session, or uses the pending picker.
 */
export function useSessionAgentTargetSync(
  sessions: ApiSessionListItem[],
  setSessions: Dispatch<SetStateAction<ApiSessionListItem[]>>,
  identity: BoundaryIdentity | null,
): void {
  const identityKey = identity ? `${identity.tenantId}:${identity.userId}:${identity.generation}` : 'anonymous';
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
  const latestRef = useRef(sessions);
  latestRef.current = sessions;
  const enqueueRef = useRef<((session: ApiSessionListItem) => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    let running = 0;
    const seen = new Set<string>();
    const queue: string[] = [];
    const controllers = new Set<AbortController>();
    const isCurrent = () => !disposed && identityKeyRef.current === identityKey;

    async function hydrate(sessionId: string, controller: AbortController): Promise<void> {
      const { signal } = controller;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (!isCurrent() || signal.aborted) return;
        // A concurrent list/detail update may already have resolved the placeholder.
        const current = latestRef.current.find((session) => session.sessionId === sessionId);
        if (!current || !needsSessionAgentTargetSync(current)) return;
        let retry = true;
        try {
          const response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}?limit=1`, { signal });
          if (!isCurrent() || signal.aborted) return;
          if (response.ok) {
            const fields = parseSessionAgentTargetIdentity(await response.json(), sessionId, identity?.tenantId);
            if (!isCurrent() || signal.aborted) return;
            if (fields) {
              setSessions((previous) => isCurrent()
                ? applySessionAgentTargetIdentity(previous, sessionId, fields)
                : previous);
              return;
            }
          } else {
            // 404 can be a just-created metadata visibility race; auth refusals are not retried.
            retry = response.status === 404 || response.status === 429 || response.status >= 500;
          }
        } catch {
          if (!isCurrent() || signal.aborted) return;
        }
        if (!retry || attempt === RETRY_DELAYS_MS.length) break;
        await delay(RETRY_DELAYS_MS[attempt]!, signal);
      }
      if (!isCurrent() || signal.aborted) return;
      // A network/compatibility failure is pending identity, not proof of a legacy broken binding.
      setSessions((previous) => isCurrent() ? applySessionAgentTargetIdentity(previous, sessionId, {
        agentTargetUnavailableReason: SESSION_BINDING_SYNC_FAILED,
      }) : previous);
    }

    function pump(): void {
      while (isCurrent() && running < MAX_CONCURRENT_IDENTITY_READS && queue.length) {
        const sessionId = queue.shift()!;
        const controller = new AbortController();
        controllers.add(controller);
        running += 1;
        void hydrate(sessionId, controller).finally(() => {
          controllers.delete(controller);
          running -= 1;
          pump();
        });
      }
    }
    enqueueRef.current = (session) => {
      const { sessionId } = session;
      // A later stale list may lose identity again; allow a new reconciliation after resolution.
      if (!needsSessionAgentTargetSync(session)) { seen.delete(sessionId); return; }
      if (!isCurrent() || seen.has(sessionId)) return;
      seen.add(sessionId);
      queue.push(sessionId);
      pump();
    };
    return () => {
      disposed = true;
      enqueueRef.current = null;
      queue.length = 0;
      for (const controller of controllers) controller.abort();
    };
  }, [identityKey, identity?.tenantId, setSessions]);

  useEffect(() => {
    for (const session of sessions) enqueueRef.current?.(session);
  }, [sessions, identityKey]);
}

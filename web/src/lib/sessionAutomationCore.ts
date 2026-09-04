import type { SessionAutomationSnapshot } from '@/lib/sessionAutomation';

export function createStableClientMsgId(): string {
  return crypto.randomUUID?.() ?? `automation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Accept both the flattened design contract and the shared spec envelope. */
export function normalizeAutomationSnapshot(snapshot: SessionAutomationSnapshot): SessionAutomationSnapshot {
  const spec = snapshot.spec;
  if (!spec) return snapshot;
  return {
    ...snapshot,
    kind: snapshot.kind ?? spec.kind ?? 'goal',
    mode: snapshot.mode ?? spec.mode,
    condition: snapshot.condition ?? spec.condition,
    prompt: snapshot.prompt ?? spec.prompt,
    intervalMs: snapshot.intervalMs ?? spec.intervalMs,
    budget: snapshot.budget ?? spec.budget,
    nextActionAt: snapshot.nextActionAt ?? snapshot.nextWakeupAt,
    currentRunActive: snapshot.currentRunActive ?? Boolean(snapshot.activeRunId),
  };
}

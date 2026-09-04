export type SessionAutomationKind = 'goal' | 'loop';
export type SessionAutomationStatus =
  | 'active' | 'paused' | 'blocked' | 'budget_limited' | 'completed'
  | 'failed' | 'expired' | 'cancelling' | 'reconcile_required' | string;

export interface SessionAutomationBudget {
  maxRuns?: number;
  turns?: number;
  maxTurns?: number;
  tokens?: number;
  maxTokens?: number;
  credits?: number;
  maxCredits?: number;
  timeMs?: number;
  maxTimeMs?: number;
  usedTurns?: number;
  usedTokens?: number;
  usedCredits?: number;
  elapsedMs?: number;
  expiresAt?: string;
}

export interface SessionAutomationSnapshot {
  automationId: string;
  incarnationId: string;
  kind: SessionAutomationKind;
  status: SessionAutomationStatus;
  phase?: string | null;
  projectionVersion: number;
  controlVersion: number;
  condition?: string | null;
  prompt?: string | null;
  mode?: 'fixed' | 'adaptive' | string;
  intervalMs?: number | null;
  budget?: SessionAutomationBudget | null;
  runCount?: number;
  maxRuns?: number | null;
  modelRequestCount?: number;
  continuationCount?: number;
  nextActionAt?: string | null;
  nominalNextSlotAt?: string | null;
  actualNextWakeAt?: string | null;
  latestProgress?: string | null;
  evaluatorReason?: string | null;
  latestResult?: string | null;
  consecutiveFailures?: number;
  missedSlots?: number;
  expiresAt?: string | null;
  currentRunActive?: boolean;
  willContinue?: boolean;
  spec?: {
    kind?: SessionAutomationKind;
    mode?: string;
    condition?: string;
    prompt?: string;
    intervalMs?: number;
    budget?: SessionAutomationBudget;
  };
  nextWakeupAt?: string | null;
  activeRunId?: string | null;
  [key: string]: unknown;
}

export interface AutomationTimelineEvent {
  eventId: string;
  type: string;
  createdAt?: string;
  message?: string;
  snapshot?: SessionAutomationSnapshot;
  [key: string]: unknown;
}

export interface AutomationCommandResponse {
  status: 'committed' | string;
  replayed?: boolean;
  commandId?: string;
  clientMsgId?: string;
  sessionId: string;
  automation: SessionAutomationSnapshot | null;
  cursor?: string | null;
}

export interface AutomationControlRequest {
  action: 'pause' | 'resume' | 'clear' | 'run_now' | 'edit';
  payload?: Record<string, unknown>;
}

export interface AutomationCompactProjection {
  kind?: SessionAutomationKind;
  status?: string;
  label?: string;
  runCount?: number;
  maxRuns?: number;
  nextActionAt?: string | null;
  reason?: string | null;
}

export function getAutomationTranscriptLabel(message: unknown): string | null {
  const value = message as {
    automation?: { kind?: SessionAutomationKind; turn?: number; run?: number; sequence?: number };
    automationKind?: SessionAutomationKind;
    automationTurn?: number;
    automationRun?: number;
  };
  const kind = value.automation?.kind ?? value.automationKind;
  if (!kind) return null;
  const sequence = kind === 'goal'
    ? value.automation?.turn ?? value.automationTurn ?? value.automation?.sequence
    : value.automation?.run ?? value.automationRun ?? value.automation?.sequence;
  return `${kind === 'goal' ? 'Goal turn' : 'Loop run'}${sequence === undefined ? '' : ` ${sequence}`}`;
}

export function getSessionAutomationBadge(session: unknown, now = Date.now()): string | null {
  const value = session as { automation?: AutomationCompactProjection | null; automationSummary?: AutomationCompactProjection | null };
  const automation = value.automation ?? value.automationSummary;
  if (!automation) return null;
  if (automation.label) return automation.label;
  if (automation.status === 'paused') return `Paused${automation.reason ? ` · ${automation.reason}` : ''}`;
  if (automation.kind === 'goal') {
    const progress = automation.maxRuns ? ` · ${automation.runCount ?? 0}/${automation.maxRuns}` : '';
    return `Goal${progress}${automation.status ? ` · ${automation.status}` : ''}`;
  }
  if (automation.kind === 'loop') {
    if (automation.nextActionAt) {
      const minutes = Math.max(0, Math.ceil((new Date(automation.nextActionAt).getTime() - now) / 60_000));
      return `Loop · ${minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`} 后`;
    }
    return `Loop${automation.status ? ` · ${automation.status}` : ''}`;
  }
  return automation.status ?? null;
}

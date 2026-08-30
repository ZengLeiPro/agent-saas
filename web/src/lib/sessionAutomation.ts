import { authFetch } from '@/lib/authFetch';

export type SessionAutomationKind = 'goal' | 'loop';
export type SessionAutomationStatus =
  | 'active' | 'paused' | 'blocked' | 'budget_limited' | 'completed'
  | 'failed' | 'expired' | 'cancelling' | 'reconcile_required' | string;

export interface SessionAutomationBudget {
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

/** Web control actions; run_now maps to the shared API's run action. */
export interface AutomationControlRequest {
  action: 'pause' | 'resume' | 'clear' | 'run_now' | 'edit';
  payload?: Record<string, unknown>;
}

export function isSessionAutomationCommand(value: string): boolean {
  return /^\s*\/(?:loop|goal)(?=\s|$)/i.test(value);
}

export function createStableClientMsgId(): string {
  return crypto.randomUUID?.() ?? `automation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Accept both the design-contract flattened snapshot and the shared implementation's spec envelope. */
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

async function readApiError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: string; message?: string; code?: string } | null;
  const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
  Object.assign(error, { status: response.status, code: body?.code });
  return error;
}

export async function submitAutomationCommand(args: {
  clientMsgId: string;
  sessionId: string | null;
  rawCommand: string;
  attachmentIds: string[];
  expectedControlVersion?: number | null;
  expectedIncarnationId?: string | null;
}): Promise<AutomationCommandResponse> {
  let response = await authFetch('/api/session-automations/commands', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': args.clientMsgId,
    },
    body: JSON.stringify({
      clientMsgId: args.clientMsgId,
      sessionId: args.sessionId,
      rawCommand: args.rawCommand,
      expectedControlVersion: args.expectedControlVersion ?? null,
      expectedIncarnationId: args.expectedIncarnationId ?? null,
      attachments: args.attachmentIds.map((attachmentId) => ({ attachmentId })),
    }),
  });
  // Compatibility during TASK-338 integration: the shared API initially shipped a nested route.
  if (response.status === 404 && args.sessionId) {
    response = await authFetch(`/api/sessions/${encodeURIComponent(args.sessionId)}/automations/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': args.clientMsgId },
      body: JSON.stringify({
        clientMessageId: args.clientMsgId,
        command: args.rawCommand,
        expectedControlVersion: args.expectedControlVersion ?? undefined,
        expectedIncarnationId: args.expectedIncarnationId ?? undefined,
      }),
    });
  }
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as AutomationCommandResponse | { result: string; snapshot?: SessionAutomationSnapshot };
  if ('sessionId' in body) return { ...body, automation: body.automation ? normalizeAutomationSnapshot(body.automation) : null };
  return {
    status: body.result,
    sessionId: args.sessionId ?? '',
    automation: body.snapshot ? normalizeAutomationSnapshot(body.snapshot) : null,
  };
}

export async function fetchSessionAutomation(sessionId: string): Promise<{
  snapshot: SessionAutomationSnapshot | null;
  cursor: string | null;
}> {
  const response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/automation`);
  if (response.status === 404) {
    const listResponse = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/automations`);
    if (listResponse.status === 404) return { snapshot: null, cursor: null };
    if (!listResponse.ok) throw await readApiError(listResponse);
    const list = await listResponse.json() as { items?: SessionAutomationSnapshot[] };
    const current = (list.items ?? []).find((item) => !['completed', 'cancelled', 'failed', 'expired'].includes(item.status)) ?? list.items?.[0] ?? null;
    return { snapshot: current ? normalizeAutomationSnapshot(current) : null, cursor: null };
  }
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as SessionAutomationSnapshot | {
    automation?: SessionAutomationSnapshot | null;
    snapshot?: SessionAutomationSnapshot | null;
    cursor?: string | null;
  };
  if ('automationId' in body) return { snapshot: normalizeAutomationSnapshot(body as SessionAutomationSnapshot), cursor: null };
  const snapshot = body.snapshot ?? body.automation ?? null;
  return { snapshot: snapshot ? normalizeAutomationSnapshot(snapshot) : null, cursor: body.cursor ?? null };
}

/** Cursor feed is optional during rollout; a 404 keeps the snapshot authoritative. */
export async function fetchAutomationEvents(automationId: string, cursor: string | null): Promise<{
  events: AutomationTimelineEvent[];
  cursor: string | null;
}> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await authFetch(`/api/session-automations/${encodeURIComponent(automationId)}/events${query}`);
  if (response.status === 404) return { events: [], cursor };
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as { events?: AutomationTimelineEvent[]; items?: AutomationTimelineEvent[]; cursor?: string | null; nextCursor?: string | null };
  return { events: body.events ?? body.items ?? [], cursor: body.nextCursor ?? body.cursor ?? cursor };
}

export async function controlSessionAutomation(
  snapshot: SessionAutomationSnapshot,
  request: AutomationControlRequest,
  clientMsgId = createStableClientMsgId(),
): Promise<SessionAutomationSnapshot> {
  let response = await authFetch(`/api/session-automations/${encodeURIComponent(snapshot.automationId)}/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': clientMsgId,
    },
    body: JSON.stringify({
      clientMsgId,
      expectedControlVersion: snapshot.controlVersion,
      expectedIncarnationId: snapshot.incarnationId,
      action: request.action,
      payload: request.payload ?? {},
    }),
  });
  if (response.status === 404 && typeof snapshot.sessionId === 'string') {
    if (request.action === 'edit') throw new Error('当前服务端暂不支持编辑自动化，请升级后重试');
    response = await authFetch(`/api/sessions/${encodeURIComponent(snapshot.sessionId)}/automations/${encodeURIComponent(snapshot.automationId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMsgId },
      body: JSON.stringify({
        clientMessageId: clientMsgId,
        expectedControlVersion: snapshot.controlVersion,
        expectedIncarnationId: snapshot.incarnationId,
        action: request.action === 'run_now' ? 'run' : request.action,
      }),
    });
  }
  if (!response.ok) throw await readApiError(response);
  const body = await response.json() as SessionAutomationSnapshot | { automation?: SessionAutomationSnapshot; snapshot?: SessionAutomationSnapshot };
  if ('automationId' in body) return normalizeAutomationSnapshot(body as SessionAutomationSnapshot);
  const next = body.snapshot ?? body.automation;
  if (!next) throw new Error('Automation control response did not include a snapshot');
  return normalizeAutomationSnapshot(next);
}

/** Compact list projection returned with the session index. */
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

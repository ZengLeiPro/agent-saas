import { createHash } from 'node:crypto';

export const WORKLOAD_CLASSES = [
  'interactive',
  'taskboard',
  'cron',
  'memory',
  'deploy-smoke',
  'probe',
  'unknown',
] as const;

export type SandboxWorkloadClass = typeof WORKLOAD_CLASSES[number];
export interface SandboxWorkloadDescriptor {
  class: SandboxWorkloadClass;
  taskKind?: 'delivery' | 'advisory' | 'integration' | 'remediation';
  purpose?: 'work' | 'review' | 'merge';
}
export type SandboxLifecyclePolicyMode = 'shadow' | 'enforce';
// lifecycle deadlines below are intentionally capped for inactive sandboxes.
export type SandboxTerminalState = 'completed' | 'failed' | 'cancelled' | 'timed-out';

export const WORKLOAD_CLASS_LABEL = 'agent-saas.kaiyan.net/workload-class';
export const WORKLOAD_DESCRIPTOR_ANNOTATION = 'agent-saas.kaiyan.net/workload-descriptor';
export const TERMINAL_STATE_ANNOTATION = 'agent-saas.kaiyan.net/terminal-state';
export const TERMINAL_AT_ANNOTATION = 'agent-saas.kaiyan.net/terminal-at';
export const TERMINAL_OUTCOME_ANNOTATION = 'agent-saas.kaiyan.net/terminal-outcome';
export const RETENTION_DEADLINE_ANNOTATION = 'agent-saas.kaiyan.net/retention-deadline';
export const DELETION_GENERATION_ANNOTATION = 'agent-saas.kaiyan.net/deletion-generation';
export const ACTIVE_INVOCATION_LEASE_ANNOTATION_PREFIX = 'agent-saas.kaiyan.net/active-invocation-';

export const FIVE_MINUTES_MS = 5 * 60_000;
export const FIFTEEN_MINUTES_MS = 15 * 60_000;
export const MAX_INACTIVE_RETENTION_MS = 30 * 60_000;
export const UNKNOWN_RETENTION_MS = MAX_INACTIVE_RETENTION_MS;
export const PROBE_RESIDUE_GRACE_MS = FIVE_MINUTES_MS;

function terminalRetentionMs(
  workloadClass: SandboxWorkloadClass,
  terminalState: SandboxTerminalState | undefined,
): number {
  switch (workloadClass) {
    case 'taskboard':
      return FIVE_MINUTES_MS;
    case 'cron':
      return terminalState === 'completed' ? FIVE_MINUTES_MS : FIFTEEN_MINUTES_MS;
    case 'memory':
      return terminalState === 'completed' ? FIVE_MINUTES_MS : FIFTEEN_MINUTES_MS;
    case 'probe':
      return PROBE_RESIDUE_GRACE_MS;
    case 'interactive':
    case 'deploy-smoke':
    case 'unknown':
      return MAX_INACTIVE_RETENTION_MS;
  }
}

function nonTerminalRetentionMs(workloadClass: SandboxWorkloadClass): number {
  if (workloadClass === 'probe') return PROBE_RESIDUE_GRACE_MS;
  if (workloadClass === 'memory') return FIFTEEN_MINUTES_MS;
  return MAX_INACTIVE_RETENTION_MS;
}

export interface SandboxLifecycleIdentity {
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
}

export interface SandboxLifecycleUpdate extends SandboxLifecycleIdentity {
  terminalState: SandboxTerminalState;
  terminalAt: string;
  outcome?: unknown;
  retentionDeadline?: string;
}

export interface SandboxDeletionGenerationUpdate extends SandboxLifecycleIdentity {
  deletionGeneration: string;
  previousDeletionGeneration?: string;
}

export interface SandboxScopeDeletion extends SandboxLifecycleIdentity {
  deletionGeneration: string;
}

export interface SandboxLifecycleState {
  workloadClass?: SandboxWorkloadClass;
  workloadDescriptor?: SandboxWorkloadDescriptor;
  terminalState?: SandboxTerminalState;
  terminalAt?: string;
  terminalOutcome?: unknown;
  retentionDeadline?: string;
  deletionGeneration?: string;
  activeInvocationLeaseUntil?: string;
}

export type SandboxLifecycleDecisionName =
  | 'retain-active'
  | 'retain-background-protected'
  | 'retain-until-deadline'
  | 'retain-known-active'
  | 'delete-inactive-expired'
  | 'delete-terminal-expired'
  | 'delete-retention-expired'
  | 'delete-probe-residue'
  | 'delete-unknown-expired';

export interface SandboxLifecycleDecision {
  workloadClass: SandboxWorkloadClass;
  decision: SandboxLifecycleDecisionName;
  delete: boolean;
  deadlineAt?: string;
  terminalDeadlineAt?: string;
  reason: string;
}

export function parseWorkloadDescriptor(value: unknown): { ok: true; value: SandboxWorkloadDescriptor } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'workload 必须是包含 class 的对象' };
  }
  const workloadClass = (value as { class?: unknown }).class;
  if (typeof workloadClass !== 'string' || !WORKLOAD_CLASSES.includes(workloadClass as SandboxWorkloadClass)) {
    return { ok: false, error: `workload.class 必须是 ${WORKLOAD_CLASSES.join('|')}` };
  }
  const raw = value as Record<string, unknown>;
  const taskKind = typeof raw.taskKind === 'string'
    && ['delivery', 'advisory', 'integration', 'remediation'].includes(raw.taskKind)
    ? raw.taskKind as SandboxWorkloadDescriptor['taskKind']
    : undefined;
  const purpose = typeof raw.purpose === 'string'
    && ['work', 'review', 'merge'].includes(raw.purpose)
    ? raw.purpose as SandboxWorkloadDescriptor['purpose']
    : undefined;
  return {
    ok: true,
    value: {
      class: workloadClass as SandboxWorkloadClass,
      ...(workloadClass === 'taskboard' && taskKind ? { taskKind } : {}),
      ...(workloadClass === 'taskboard' && purpose ? { purpose } : {}),
    },
  };
}

export function workloadDescriptorFromAnnotations(
  labels: Record<string, unknown>,
  annotations: Record<string, unknown>,
): SandboxWorkloadDescriptor {
  const encoded = annotations[WORKLOAD_DESCRIPTOR_ANNOTATION];
  if (typeof encoded === 'string') {
    try {
      const parsed = parseWorkloadDescriptor(JSON.parse(encoded));
      if (parsed.ok) return parsed.value;
    } catch { /* malformed legacy annotation falls through to label/unknown */ }
  }
  const label = labels[WORKLOAD_CLASS_LABEL];
  return {
    class: typeof label === 'string' && WORKLOAD_CLASSES.includes(label as SandboxWorkloadClass)
      ? label as SandboxWorkloadClass
      : 'unknown',
  };
}

export function activeInvocationLeaseAnnotationKey(invocationKey: string): string {
  return `${ACTIVE_INVOCATION_LEASE_ANNOTATION_PREFIX}${createHash('sha256').update(invocationKey).digest('hex').slice(0, 24)}`;
}

export function activeInvocationLeaseUntil(annotations: Record<string, unknown>): string | undefined {
  let latestMs: number | undefined;
  let latest: string | undefined;
  for (const [key, raw] of Object.entries(annotations)) {
    if (!key.startsWith(ACTIVE_INVOCATION_LEASE_ANNOTATION_PREFIX) || typeof raw !== 'string') continue;
    try {
      const value = JSON.parse(raw) as { until?: unknown };
      if (typeof value.until !== 'string') continue;
      const at = Date.parse(value.until);
      if (!Number.isFinite(at) || (latestMs !== undefined && at <= latestMs)) continue;
      latestMs = at;
      latest = value.until;
    } catch { /* fail closed for malformed values is not useful without a parseable deadline */ }
  }
  return latest;
}

export function lifecycleStateFromMetadata(
  labels: Record<string, unknown>,
  annotations: Record<string, unknown>,
): SandboxLifecycleState {
  const descriptor = workloadDescriptorFromAnnotations(labels, annotations);
  const terminalStateRaw = annotations[TERMINAL_STATE_ANNOTATION];
  const terminalState = typeof terminalStateRaw === 'string'
    && ['completed', 'failed', 'cancelled', 'timed-out'].includes(terminalStateRaw)
    ? terminalStateRaw as SandboxTerminalState
    : undefined;
  const outcomeRaw = annotations[TERMINAL_OUTCOME_ANNOTATION];
  let terminalOutcome: unknown;
  if (typeof outcomeRaw === 'string') {
    try { terminalOutcome = JSON.parse(outcomeRaw); } catch { terminalOutcome = outcomeRaw; }
  }
  return {
    workloadClass: descriptor.class,
    workloadDescriptor: descriptor,
    ...(terminalState ? { terminalState } : {}),
    ...(typeof annotations[TERMINAL_AT_ANNOTATION] === 'string' ? { terminalAt: annotations[TERMINAL_AT_ANNOTATION] as string } : {}),
    ...(outcomeRaw === undefined ? {} : { terminalOutcome }),
    ...(typeof annotations[RETENTION_DEADLINE_ANNOTATION] === 'string' ? { retentionDeadline: annotations[RETENTION_DEADLINE_ANNOTATION] as string } : {}),
    ...(typeof annotations[DELETION_GENERATION_ANNOTATION] === 'string' ? { deletionGeneration: annotations[DELETION_GENERATION_ANNOTATION] as string } : {}),
    ...(() => {
      const until = activeInvocationLeaseUntil(annotations);
      return until ? { activeInvocationLeaseUntil: until } : {};
    })(),
  };
}

export function isActiveInvocationLeaseProtected(
  sandbox: Pick<SandboxLifecycleState, 'activeInvocationLeaseUntil'>,
  nowMs: number,
): boolean {
  const leaseMs = sandbox.activeInvocationLeaseUntil ? Date.parse(sandbox.activeInvocationLeaseUntil) : Number.NaN;
  return Number.isFinite(leaseMs) && leaseMs > nowMs;
}

export function terminalDeadlineAt(
  workloadClass: SandboxWorkloadClass,
  terminalAt: string | undefined,
  terminalState?: SandboxTerminalState,
): string | undefined {
  if (!terminalAt) return undefined;
  const at = Date.parse(terminalAt);
  return Number.isFinite(at)
    ? new Date(at + terminalRetentionMs(workloadClass, terminalState)).toISOString()
    : undefined;
}

export function decideSandboxLifecycle(input: SandboxLifecycleState & {
  createdAt?: string;
  lastActiveAt?: string;
  nowMs: number;
  active?: boolean;
  backgroundProtected?: boolean;
}): SandboxLifecycleDecision {
  const workloadClass = input.workloadClass ?? input.workloadDescriptor?.class ?? 'unknown';
  if (input.active || isActiveInvocationLeaseProtected(input, input.nowMs)) {
    return { workloadClass, decision: 'retain-active', delete: false, reason: 'active registry or persistent invocation lease' };
  }
  if (input.backgroundProtected) {
    return { workloadClass, decision: 'retain-background-protected', delete: false, reason: 'background shell protection' };
  }

  const createdAtMs = parseDate(input.createdAt);
  const lastActiveAtMs = parseDate(input.lastActiveAt) ?? createdAtMs;
  const terminalAtMs = parseDate(input.terminalAt);
  // A terminal transition is lifecycle activity. Without this max(), a long-running task whose
  // last tool call was old could be deleted immediately instead of receiving its 5m/15m window.
  const lifecycleActivityAtMs = [createdAtMs, lastActiveAtMs, terminalAtMs]
    .filter((value): value is number => value !== undefined)
    .reduce<number | undefined>((latest, value) => latest === undefined ? value : Math.max(latest, value), undefined);
  const inactiveDeadlineMs = lifecycleActivityAtMs === undefined
    ? undefined
    : lifecycleActivityAtMs + nonTerminalRetentionMs(workloadClass);
  const terminalDeadline = terminalDeadlineAt(workloadClass, input.terminalAt, input.terminalState);
  const terminalDeadlineMs = parseDate(terminalDeadline);
  const explicitDeadlineMs = parseDate(input.retentionDeadline);

  // The earliest policy/explicit deadline wins, so callers cannot extend an inactive Sandbox
  // beyond its workload cap with a retentionDeadline override.
  const deadlines = [
    ...(inactiveDeadlineMs === undefined ? [] : [{ source: 'inactive' as const, at: inactiveDeadlineMs }]),
    ...(terminalDeadlineMs === undefined ? [] : [{ source: 'terminal' as const, at: terminalDeadlineMs }]),
    ...(explicitDeadlineMs === undefined ? [] : [{ source: 'retention' as const, at: explicitDeadlineMs }]),
  ].sort((left, right) => left.at - right.at);
  const effective = deadlines[0];
  if (!effective) {
    return { workloadClass, decision: 'retain-known-active', delete: false, reason: 'lifecycle timestamps are unavailable' };
  }

  const expired = input.nowMs >= effective.at;
  const deadlineAt = new Date(effective.at).toISOString();
  let expiredDecision: SandboxLifecycleDecisionName;
  if (workloadClass === 'probe') expiredDecision = 'delete-probe-residue';
  else if (effective.source === 'retention') expiredDecision = 'delete-retention-expired';
  else if (effective.source === 'terminal') expiredDecision = 'delete-terminal-expired';
  else if (workloadClass === 'unknown') expiredDecision = 'delete-unknown-expired';
  else expiredDecision = 'delete-inactive-expired';

  return {
    workloadClass,
    decision: expired ? expiredDecision : 'retain-until-deadline',
    delete: expired,
    deadlineAt,
    ...(terminalDeadline ? { terminalDeadlineAt: terminalDeadline } : {}),
    reason: expired
      ? `${effective.source} lifecycle deadline expired`
      : `${effective.source} lifecycle deadline pending`,
  };
}

export function parseLifecycleUpdate(value: unknown): { ok: true; value: SandboxLifecycleUpdate } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'body 必须是对象' };
  const raw = value as Record<string, unknown>;
  const identity = parseLifecycleIdentity(raw);
  if (!identity.ok) return identity;
  if (typeof raw.terminalState !== 'string' || !['completed', 'failed', 'cancelled', 'timed-out'].includes(raw.terminalState)) {
    return { ok: false, error: 'terminalState 必须是 completed|failed|cancelled|timed-out' };
  }
  if (!validIso(raw.terminalAt)) return { ok: false, error: 'terminalAt 必须是合法 ISO 时间' };
  if (raw.retentionDeadline !== undefined && !validIso(raw.retentionDeadline)) {
    return { ok: false, error: 'retentionDeadline 必须是合法 ISO 时间' };
  }
  if (raw.outcome !== undefined && Buffer.byteLength(JSON.stringify(raw.outcome), 'utf8') > 8 * 1024) {
    return { ok: false, error: 'outcome 超过 8KiB' };
  }
  return {
    ok: true,
    value: {
      ...identity.value,
      terminalState: raw.terminalState as SandboxTerminalState,
      terminalAt: raw.terminalAt as string,
      ...(raw.outcome === undefined ? {} : { outcome: raw.outcome }),
      ...(raw.retentionDeadline === undefined ? {} : { retentionDeadline: raw.retentionDeadline as string }),
    },
  };
}

export function parseDeletionGenerationUpdate(value: unknown): { ok: true; value: SandboxDeletionGenerationUpdate } | { ok: false; error: string } {
  const identity = parseLifecycleIdentity(value);
  if (!identity.ok) return identity;
  const raw = value as Record<string, unknown>;
  if (typeof raw.deletionGeneration !== 'string' || !raw.deletionGeneration.trim()) {
    return { ok: false, error: 'deletionGeneration 必须是非空字符串' };
  }
  if (raw.previousDeletionGeneration !== undefined
    && (typeof raw.previousDeletionGeneration !== 'string' || !raw.previousDeletionGeneration.trim())) {
    return { ok: false, error: 'previousDeletionGeneration 必须是非空字符串' };
  }
  return {
    ok: true,
    value: {
      ...identity.value,
      deletionGeneration: raw.deletionGeneration.trim(),
      ...(typeof raw.previousDeletionGeneration === 'string'
        ? { previousDeletionGeneration: raw.previousDeletionGeneration.trim() }
        : {}),
    },
  };
}

export function parseScopeDeletion(value: unknown): { ok: true; value: SandboxScopeDeletion } | { ok: false; error: string } {
  const parsed = parseDeletionGenerationUpdate(value);
  if (!parsed.ok) return parsed;
  const { previousDeletionGeneration: _previous, ...command } = parsed.value;
  return { ok: true, value: command };
}

export function parseLifecycleIdentity(value: unknown): { ok: true; value: SandboxLifecycleIdentity } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'body 必须是对象' };
  const raw = value as Record<string, unknown>;
  for (const field of ['workspaceId', 'sessionId', 'sandboxScopeId'] as const) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) return { ok: false, error: `${field} 必须是非空字符串` };
  }
  return {
    ok: true,
    value: {
      workspaceId: (raw.workspaceId as string).trim(),
      sessionId: (raw.sessionId as string).trim(),
      sandboxScopeId: (raw.sandboxScopeId as string).trim(),
    },
  };
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

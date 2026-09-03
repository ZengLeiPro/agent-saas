import { createHash } from 'node:crypto';

export type GoalEvidenceKind = 'event' | 'tool_result' | 'test' | 'build';
export interface GoalEvidenceManifestEntry {
  ref: string;
  kind: GoalEvidenceKind;
  tenantId: string;
  sessionId: string;
  rootAutomationId: string;
  source: { eventId: string; runId: string; toolCallId?: string };
  version: { globalSequence: number; sha256: string };
  freshness: { capturedAt: string; freshThroughGlobalSequence: number };
  content: { toolName: string; resultExcerpt: string; command?: string; exitCode?: number };
}
export interface GoalEvidenceManifest {
  version: 1;
  fence: {
    tenantId: string;
    sessionId: string;
    rootAutomationId: string;
    executionId: string;
    incarnationId: string;
    generation: number;
    specVersion: number;
    runId: string;
  };
  entries: GoalEvidenceManifestEntry[];
  canonicalHash: string;
}
export interface GoalEvidence {
  summary: string;
  evidenceManifest: GoalEvidenceManifest;
  hardGates: {
    runTerminal: boolean;
    noPendingInteraction: boolean;
    noActiveResources: boolean;
    budgetValid: boolean;
    noNewUserInput: boolean;
  };
}
export type GoalDecision = 'met' | 'continue' | 'blocked' | 'unverifiable';

export function canonicalGoalEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalGoalEvidenceJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalGoalEvidenceJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function goalEvidenceSha256(value: unknown): string {
  return createHash('sha256').update(canonicalGoalEvidenceJson(value)).digest('hex');
}
export function goalEvidenceManifestHash(manifest: Omit<GoalEvidenceManifest, 'canonicalHash'>): string {
  return goalEvidenceSha256(manifest);
}
export function isValidGoalEvidenceManifest(manifest: unknown, expectedHash?: string): manifest is GoalEvidenceManifest {
  if (!manifest || typeof manifest !== 'object') return false;
  const value = manifest as GoalEvidenceManifest;
  if (value.version !== 1 || !value.fence || typeof value.fence !== 'object'
    || typeof value.fence.tenantId !== 'string' || typeof value.fence.sessionId !== 'string'
    || typeof value.fence.rootAutomationId !== 'string' || typeof value.fence.executionId !== 'string'
    || typeof value.fence.incarnationId !== 'string' || !Number.isSafeInteger(value.fence.generation)
    || !Number.isSafeInteger(value.fence.specVersion) || typeof value.fence.runId !== 'string'
    || !Array.isArray(value.entries) || value.entries.length === 0 || typeof value.canonicalHash !== 'string') return false;
  if (value.entries.some(entry => !entry || typeof entry.ref !== 'string' || !['event','tool_result','test','build'].includes(entry.kind)
    || typeof entry.tenantId !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.rootAutomationId !== 'string'
    || !entry.source || typeof entry.source.eventId !== 'string' || typeof entry.source.runId !== 'string'
    || !entry.version || !Number.isSafeInteger(entry.version.globalSequence) || typeof entry.version.sha256 !== 'string'
    || !entry.freshness || typeof entry.freshness.capturedAt !== 'string' || !Number.isSafeInteger(entry.freshness.freshThroughGlobalSequence)
    || !entry.content || typeof entry.content.toolName !== 'string' || typeof entry.content.resultExcerpt !== 'string'
    || entry.content.resultExcerpt.length > 6_000 || (entry.content.command !== undefined && typeof entry.content.command !== 'string')
    || (entry.content.exitCode !== undefined && !Number.isSafeInteger(entry.content.exitCode)))) return false;
  const { canonicalHash, ...body } = value;
  return canonicalHash === goalEvidenceManifestHash(body) && (!expectedHash || canonicalHash === expectedHash);
}
export function passesGoalHardGates(evidence: GoalEvidence): boolean {
  return evidence.hardGates.runTerminal && evidence.hardGates.noPendingInteraction
    && evidence.hardGates.noActiveResources && evidence.hardGates.budgetValid
    && evidence.hardGates.noNewUserInput && isValidGoalEvidenceManifest(evidence.evidenceManifest);
}
export function goalEvidenceFreshThrough(manifest: unknown): number {
  const entries=(manifest as GoalEvidenceManifest|undefined)?.entries;
  if(!Array.isArray(entries)||entries.length===0)return 0;
  const values=entries.map(entry=>entry?.freshness?.freshThroughGlobalSequence);
  return values.every(Number.isSafeInteger)?Math.min(...values as number[]):0;
}

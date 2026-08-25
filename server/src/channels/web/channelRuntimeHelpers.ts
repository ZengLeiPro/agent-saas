import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { Semaphore } from '../../runtime/fileReadCoalesce.js';
import type { InteractionResponse } from '../../agent/types.js';
import type { RunRecord, RunStatus, RunStore } from '../../runtime/runStore.js';
import type { EventStore } from '../../runtime/types.js';
import { openTrustedDirectory, withTrustedFile } from '../../security/trustedFile.js';

/** Bounds cross-session approval resume work while per-file reads are coalesced. */
export const approvalResumeSemaphore = new Semaphore(8);

export const INTERACTIVE_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'RequestPluginInstall',
]);

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

type PersistedInteractionType = 'ask_user' | 'approval';
/** A crashed staged claimant may be recovered after this bounded lease. */
export const PERSISTED_INTERACTION_CLAIM_LEASE_MS = 30_000;
export type PersistedInteractionClaimMetadata = {
  persistedInteractionResumeClaim: {
    sessionId: string;
    interactionId: string;
    interactionType: PersistedInteractionType;
    /** Per-attempt token prevents a stale claimant rolling back a newer retry. */
    claimId: string;
    /** ISO timestamp used to distinguish a live claimant from a crashed one. */
    claimedAt: string;
  };
  resumeInteraction?: { interactionId: string; response: InteractionResponse };
  resumeApproval?: { approvalId: string; response: InteractionResponse };
};

export type PersistedInteractionResumeClaim =
  | { outcome: 'claimed'; run: RunRecord; metadata: PersistedInteractionClaimMetadata }
  | { outcome: 'rejected' }
  | { outcome: 'unsupported' };

/** Atomically fence a persisted interaction resume across web workers. */
export async function claimPersistedInteractionResume(input: {
  runStore: Pick<RunStore, 'claimPersistedInteractionResume'>;
  runId: string;
  expectedStatus: RunStatus;
  reason: string;
  sessionId: string;
  interactionId: string;
  interactionType: PersistedInteractionType;
  response: InteractionResponse;
  transcriptPath?: string;
}): Promise<PersistedInteractionResumeClaim> {
  const metadata: PersistedInteractionClaimMetadata = {
    persistedInteractionResumeClaim: {
      sessionId: input.sessionId,
      interactionId: input.interactionId,
      interactionType: input.interactionType,
      claimId: randomUUID(),
      claimedAt: new Date().toISOString(),
    },
    ...(input.interactionType === 'ask_user'
      ? { resumeInteraction: { interactionId: input.interactionId, response: input.response } }
      : { resumeApproval: { approvalId: input.interactionId, response: input.response } }),
  };
  const metadataPatch = {
    ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
    ...(input.interactionType === 'ask_user'
      ? { resumeInteractionConsumedAt: null, resumeInteractionConsumedId: null }
      : { resumeApprovalConsumedAt: null, resumeApprovalConsumedId: null }),
    ...metadata,
  };
  const claimPersistedInteractionResume = input.runStore.claimPersistedInteractionResume;
  if (!claimPersistedInteractionResume) return { outcome: 'unsupported' };
  const run = await claimPersistedInteractionResume.call(
    input.runStore,
    input.runId,
    [input.expectedStatus],
    input.reason,
    metadataPatch,
  );
  return run ? { outcome: 'claimed', run, metadata } : { outcome: 'rejected' };
}

export function hasPersistedInteractionResumeClaim(
  metadata: Record<string, unknown> | undefined,
  sessionId: string,
  interactionId: string,
): boolean {
  const claim = metadata?.persistedInteractionResumeClaim;
  return Boolean(
    claim && typeof claim === 'object'
    && (claim as Record<string, unknown>).sessionId === sessionId
    && (claim as Record<string, unknown>).interactionId === interactionId,
  );
}

export function isPersistedInteractionClaim(value: unknown, sessionId: string, interactionId: string): value is PersistedInteractionClaimMetadata['persistedInteractionResumeClaim'] {
  return Boolean(value && typeof value === 'object' && typeof (value as Record<string, unknown>).claimId === 'string' && (value as Record<string, unknown>).sessionId === sessionId && (value as Record<string, unknown>).interactionId === interactionId);
}

export function claimsMatch(actual: unknown, expected: PersistedInteractionClaimMetadata['persistedInteractionResumeClaim']): boolean {
  return isPersistedInteractionClaim(actual, expected.sessionId, expected.interactionId)
    && (actual as Record<string, unknown>).claimId === expected.claimId
    && (actual as Record<string, unknown>).claimedAt === expected.claimedAt;
}

export function isPersistedInteractionClaimExpired(claim: PersistedInteractionClaimMetadata['persistedInteractionResumeClaim']): boolean {
  const claimedAt = (claim as Record<string, unknown>).claimedAt;
  if (typeof claimedAt !== 'string') return true; // pre-lease claims are recoverable legacy state
  const claimedAtMs = Date.parse(claimedAt);
  return !Number.isFinite(claimedAtMs) || Date.now() - claimedAtMs >= PERSISTED_INTERACTION_CLAIM_LEASE_MS;
}

export function persistedInteractionEventId(sessionId: string, interactionId: string): string {
  return `interaction_resolved:${sessionId}:${interactionId}`;
}

/** Read back a stable id after an uncertain append before deciding whether to roll back a claim. */
export async function appendPersistedInteractionResolved(
  eventStore: EventStore,
  tenantId: string,
  event: Extract<Parameters<EventStore['append']>[0], { type: 'interaction_resolved' }> & { id: string },
): Promise<void> {
  try {
    await eventStore.append(event, { tenantId });
  } catch (error) {
    const accepted = await eventStore.list(tenantId, event.sessionId)
      .then((events) => events.some((candidate) => candidate.id === event.id))
      .catch(() => false);
    if (accepted) return;
    throw error;
  }
}

/** 语音转写前缀标记（STT 注入 / 门禁判定前剥离共用） */
export const VOICE_STT_TAG = '[这是一条语音转文字的消息，可能存在识别准确度问题] ';

export function wantsToolAutoApproval(
  policy: { autoApproveTools?: boolean; autoApproveRunShell?: boolean } | undefined,
): boolean {
  return policy?.autoApproveTools === true || policy?.autoApproveRunShell === true;
}

/** 读取用户 workspace 内最近生成的 plan 文件内容。 */
export async function readLatestPlanContent(userCwd?: string): Promise<string | null> {
  if (!userCwd) return null;
  const plansRelativePath = '.ky-agent/plans';

  try {
    const plans = await openTrustedDirectory(userCwd, plansRelativePath);
    try {
      const now = Date.now();
      let latest: { mtime: number; content: string } | null = null;
      const files = await readdir(plans.fdPath);
      for (const name of files) {
        if (!name.endsWith('.md')) continue;
        try {
          const candidate = await withTrustedFile(
            userCwd,
            `${plansRelativePath}/${name}`,
            async file => ({
              mtime: file.stats.mtimeMs,
              content: await file.handle.readFile({ encoding: 'utf-8' }),
            }),
          );
          if (candidate.mtime > (latest?.mtime ?? 0) && (now - candidate.mtime) < 60_000) {
            latest = candidate;
          }
        } catch {
          // Ignore files that disappear or become unsafe while the directory is scanned.
        }
      }
      return latest?.content ?? null;
    } finally {
      await plans.handle.close();
    }
  } catch {
    return null;
  }
}

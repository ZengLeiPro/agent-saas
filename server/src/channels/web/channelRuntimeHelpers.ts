import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { Semaphore } from '../../runtime/fileReadCoalesce.js';
import type { InteractionResponse } from '../../agent/types.js';
import { EventBackedApprovalStore } from '../../runtime/approvalStore.js';
import { buildPendingInteractionsFromEvents, normalizeInteractionResponse } from '../../runtime/interactionProjection.js';
import { FileEventStore, getRuntimeEventLogPath } from '../../runtime/fileEventStore.js';
import { buildRuntimeReplayState } from '../../runtime/replay.js';
import type { RunRecord, RunStatus, RunStore } from '../../runtime/runStore.js';
import type { EventStore, PlatformEvent } from '../../runtime/types.js';
import { openTrustedDirectory, withTrustedFile } from '../../security/trustedFile.js';
import { chatLogger } from '../../utils/logger.js';

/** Bounds cross-session approval resume work while per-file reads are coalesced. */
export const approvalResumeSemaphore = new Semaphore(8);

export const INTERACTIVE_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'RequestPluginInstall',
]);

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned']);

type TerminalAskUserResumeResult =
  | { canonicalResponse: InteractionResponse; activated: boolean }
  | { error: string };

/** Persist a terminal ask_user response, then idempotently stage and activate its synthetic resume run. */
export async function resumeTerminalPersistedAskUser(input: {
  eventStore: EventStore;
  runStore: Pick<RunStore, 'get'>;
  scheduler: {
    enqueue(run: Parameters<RunStore['upsertPending']>[0]): Promise<RunRecord>;
    activateCreatedRun?(runId: string): Promise<RunRecord | null>;
  };
  tenantId: string;
  sessionId: string;
  interactionId: string;
  sourceRun: RunRecord;
  pendingAskUser: { runId?: string; toolCallId?: string; invocationId?: string };
  response: InteractionResponse;
  userId?: string | null;
  fallback: { userId: string; model?: string; executionTarget?: string; workspaceId?: string };
  transcriptPath?: string | null;
}): Promise<TerminalAskUserResumeResult> {
  const { tenantId, sessionId, interactionId, sourceRun, pendingAskUser } = input;
  const sourceRunId = pendingAskUser.runId!;
  const canonicalResolved = await appendPersistedInteractionResolved(input.eventStore, tenantId, {
    id: persistedInteractionEventId(sessionId, interactionId), type: 'interaction_resolved', sessionId,
    runId: sourceRunId, toolCallId: pendingAskUser.toolCallId,
    ...(pendingAskUser.invocationId ? { invocationId: pendingAskUser.invocationId } : {}),
    interactionId, interactionType: 'ask_user', userId: input.userId ?? undefined, response: input.response,
  });
  const canonicalResponse = normalizeInteractionResponse(canonicalResolved.response as Record<string, unknown>);
  const resumeRunId = `interaction-resume:${sessionId}:${interactionId}`;
  let resumeRun = await input.runStore.get(resumeRunId);
  if (!resumeRun) {
    try {
      resumeRun = await input.scheduler.enqueue({
        runId: resumeRunId, sessionId, userId: sourceRun.userId ?? input.fallback.userId, tenantId,
        model: sourceRun.model ?? input.fallback.model, channel: 'web',
        executionTarget: sourceRun.executionTarget ?? input.fallback.executionTarget as any,
        workspaceId: sourceRun.workspaceId ?? input.fallback.workspaceId ?? sessionId,
        metadata: { ...(sourceRun.metadata ?? {}), schedulerState: 'staged', resumeInteractionConsumedAt: null,
          resumeInteractionConsumedId: null, resumeInteraction: { interactionId, response: canonicalResolved.response },
          transcriptPath: input.transcriptPath },
      });
    } catch (error) {
      chatLogger.warn(`ask_user terminal resume enqueue failed run=${resumeRunId} interaction=${interactionId}: ${error instanceof Error ? error.message : String(error)}`);
      return { error: 'Interaction response was persisted but resume enqueue failed; please retry' };
    }
  }
  if (resumeRun.status !== 'pending' || resumeRun.metadata?.schedulerState !== 'staged') {
    return { canonicalResponse, activated: false };
  }
  try {
    if (!input.scheduler.activateCreatedRun || !await input.scheduler.activateCreatedRun(resumeRunId)) {
      return { error: 'Interaction response is awaiting resume activation; please retry' };
    }
  } catch (error) {
    chatLogger.warn(`ask_user terminal resume activation failed run=${resumeRunId} interaction=${interactionId}: ${error instanceof Error ? error.message : String(error)}`);
    return { error: 'Interaction response is awaiting resume activation; please retry' };
  }
  return { canonicalResponse, activated: true };
}

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
): Promise<Extract<PlatformEvent, { type: 'interaction_resolved' }>> {
  const canonical = (candidate: PlatformEvent | undefined) => {
    if (candidate?.type !== 'interaction_resolved' || candidate.id !== event.id) throw new Error(`Interaction resolution id collision: ${event.id}`);
    return candidate;
  };
  try {
    return canonical(await eventStore.append(event, { tenantId }));
  } catch (error) {
    const accepted = await eventStore.list(tenantId, event.sessionId)
      .then((events) => events.find((candidate) => candidate.id === event.id));
    if (accepted) return canonical(accepted);
    throw error;
  }
}

export interface PersistedInteractionRecoveryState {
  eventStore: EventStore;
  approvalStore: EventBackedApprovalStore;
  existingEvents: PlatformEvent[];
  pendingApprovalRunId?: string;
  pendingAskUser?: ReturnType<typeof buildPendingInteractionsFromEvents>[number];
  hasPendingApproval: boolean;
}

/** Load durable state once, preserving ask-user recoverability after an uncertain append. */
export async function loadPersistedInteractionRecoveryState(input: {
  eventStoreFor?: (transcriptPath: string, tenantId: string) => EventStore;
  transcriptPath: string | null;
  tenantId: string;
  sessionId: string;
  interactionId: string;
}): Promise<PersistedInteractionRecoveryState> {
  const eventStore = input.eventStoreFor
    ? input.eventStoreFor(input.transcriptPath ?? '', input.tenantId)
    : new FileEventStore(getRuntimeEventLogPath(input.transcriptPath!), input.tenantId);
  const approvalStore = new EventBackedApprovalStore(eventStore, input.sessionId, input.tenantId);
  const existingEvents = await eventStore.list(input.tenantId, input.sessionId);
  const pendingState = buildRuntimeReplayState(
    existingEvents,
    await approvalStore.list(input.sessionId),
    input.sessionId,
  ).pendingApprovals.find((state) => state.approval?.id === input.interactionId);
  let pendingAskUser = buildPendingInteractionsFromEvents(existingEvents, input.sessionId)
    .find((interaction) => interaction.type === 'ask_user' && interaction.interactionId === input.interactionId);
  if (!pendingAskUser) {
    const requested = existingEvents.find((event): event is Extract<PlatformEvent, { type: 'interaction_requested' }> => (
      event.type === 'interaction_requested'
      && event.sessionId === input.sessionId
      && event.interactionId === input.interactionId
      && event.interactionType === 'ask_user'
    ));
    if (requested) {
      pendingAskUser = {
        interactionId: requested.interactionId,
        type: 'ask_user',
        sessionId: input.sessionId,
        ...(requested.runId ? { runId: requested.runId } : {}),
        ...(requested.toolCallId ? { toolCallId: requested.toolCallId } : {}),
        ...(requested.invocationId ? { invocationId: requested.invocationId } : {}),
      };
    }
  }
  return {
    eventStore,
    approvalStore,
    existingEvents,
    pendingApprovalRunId: pendingState?.approval?.runId,
    pendingAskUser,
    hasPendingApproval: Boolean(pendingState),
  };
}

export function findCanonicalPersistedApprovalResponse(
  events: PlatformEvent[],
  sessionId: string,
  interactionId: string,
): InteractionResponse | undefined {
  const canonical = events.find((event): event is Extract<PlatformEvent, { type: 'interaction_resolved' }> => (
    event.type === 'interaction_resolved'
    && event.id === persistedInteractionEventId(sessionId, interactionId)
    && event.interactionType === 'approval'
  ));
  return canonical ? normalizeInteractionResponse(canonical.response) : undefined;
}

export interface FailClosedPersistedApprovalInput {
  eventStore: EventStore;
  tenantId: string;
  approvalStore: EventBackedApprovalStore;
  sessionId: string;
  interactionId: string;
  runId: string;
  userId?: string;
  rejectionMessage: string;
}

/** Persist the canonical deny before resolving the approval projection. */
export async function failClosePersistedApproval({
  eventStore,
  tenantId,
  approvalStore,
  sessionId,
  interactionId,
  runId,
  userId,
  rejectionMessage,
}: FailClosedPersistedApprovalInput): Promise<{ response: InteractionResponse; resolved: boolean }> {
  const canonical = await appendPersistedInteractionResolved(eventStore, tenantId, {
    id: persistedInteractionEventId(sessionId, interactionId),
    type: 'interaction_resolved',
    sessionId,
    runId,
    interactionId,
    interactionType: 'approval',
    userId,
    response: { allow: false, message: rejectionMessage },
  });
  const resolved = await approvalStore.resolvePending(interactionId, 'rejected', rejectionMessage);
  return { response: normalizeInteractionResponse(canonical.response), resolved: Boolean(resolved) };
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

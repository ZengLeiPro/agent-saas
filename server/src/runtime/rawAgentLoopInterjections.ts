import { isCompactCommand } from '../agent/prompt.js';
import type { OutboundEvent } from '../types/index.js';
import { buildModelUserContent } from './imageAttachments.js';
import type { LegacyTranscriptProjection } from './legacyTranscriptProjection.js';
import type { RunStore } from './runStore.js';
import type { SteeringApplyInput } from './runStoreTypes.js';
import type {
  EventStore,
  ModelChatMessage,
  PlatformEvent,
  PlatformEventInput,
  QueuedInterjection,
  RunContext,
} from './types.js';

export function collectDurableInterjectionAnnouncementSourceRunIds(events: PlatformEvent[]): Set<string> {
  return new Set(events
    .filter((event): event is Extract<PlatformEvent, { type: 'interjection_applied' }> => (
      event.type === 'interjection_applied'
    ))
    .flatMap((event) => event.sourceRunIds));
}

export function buildAtomicSteeringInputs(
  interjections: QueuedInterjection[],
  durableInterjectionSourceRunIds: Set<string>,
  runId: string,
  sessionId: string,
): SteeringApplyInput[] {
  return interjections.map((interjection) => ({
    sourceRunId: interjection.sourceRunId,
    ...(interjection.clientMsgId ? { clientMsgId: interjection.clientMsgId } : {}),
    ...(!isCompactCommand(interjection.message.content)
      && !durableInterjectionSourceRunIds.has(interjection.sourceRunId) ? {
      event: {
        type: 'user_message' as const,
        runId,
        sessionId,
        content: interjection.message.content,
        modelContent: interjection.prompt,
        ...(interjection.attachments?.length ? { attachments: interjection.attachments } : {}),
        ...(interjection.visionAnalysis ? { visionAnalysis: interjection.visionAnalysis } : {}),
        interjectionSourceRunId: interjection.sourceRunId,
        ...(interjection.clientMsgId ? { clientMsgId: interjection.clientMsgId } : {}),
      },
    } : {}),
  }));
}

export async function projectAtomicInterjectionEvents(args: {
  events: PlatformEvent[];
  durableInterjectionSourceRunIds: Set<string>;
  durableAnnouncementSourceRunIds: Set<string>;
  transcriptProjection: LegacyTranscriptProjection;
  runId: string;
  warn: (message: string) => void;
}): Promise<void> {
  for (const event of args.events) {
    if (event.type === 'interjection_applied') {
      for (const sourceRunId of event.sourceRunIds) args.durableAnnouncementSourceRunIds.add(sourceRunId);
      continue;
    }
    if (event.type !== 'user_message' || !event.interjectionSourceRunId) continue;
    args.durableInterjectionSourceRunIds.add(event.interjectionSourceRunId);
    try {
      await args.transcriptProjection.project(event);
    } catch (error) {
      args.warn(
        `[run] interjection transcript project failed (degraded): run=${args.runId} source=${event.interjectionSourceRunId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function announceAppliedInterjections(args: {
  interjections: QueuedInterjection[];
  durableSourceRunIds: Set<string>;
  runId: string;
  sessionId: string;
  append: (event: PlatformEventInput) => Promise<void>;
  warn: (message: string) => void;
}): Promise<OutboundEvent> {
  const appliedPayload = {
    sourceRunIds: args.interjections.map((interjection) => interjection.sourceRunId),
    clientMsgIds: args.interjections.flatMap((interjection) => (
      interjection.clientMsgId ? [interjection.clientMsgId] : []
    )),
  };
  const notDurablyAnnounced = args.interjections.filter((interjection) => (
    !args.durableSourceRunIds.has(interjection.sourceRunId)
  ));
  if (notDurablyAnnounced.length > 0) {
    try {
      await args.append({
        type: 'interjection_applied',
        runId: args.runId,
        sessionId: args.sessionId,
        sourceRunIds: notDurablyAnnounced.map((interjection) => interjection.sourceRunId),
        clientMsgIds: notDurablyAnnounced.flatMap((interjection) => (
          interjection.clientMsgId ? [interjection.clientMsgId] : []
        )),
      });
      for (const interjection of notDurablyAnnounced) {
        args.durableSourceRunIds.add(interjection.sourceRunId);
      }
    } catch (error) {
      args.warn(
        `[run] durable interjection_applied append failed: run=${args.runId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { type: 'interjection_applied', ...appliedPayload };
}

export interface SteeringInterjectionCoordinatorOptions {
  context: RunContext;
  messages: ModelChatMessage[];
  priorEvents: PlatformEvent[];
  currentUserMessageIndex: number;
  runStore?: RunStore;
  eventStore: EventStore;
  tenantId: string;
  transcriptProjection: LegacyTranscriptProjection;
  append: (event: PlatformEventInput) => Promise<void>;
  warn: (message: string) => void;
}

export class SteeringInterjectionCoordinator {
  readonly manualCheckpointSourceRunIds = new Set<string>();
  readonly durableSourceRunIds: Set<string>;
  readonly modelContextSourceRunIds: Set<string>;
  readonly announcementSourceRunIds: Set<string>;
  currentUserMessageIndex: number;
  absorptionDisabled = false;

  constructor(private readonly options: SteeringInterjectionCoordinatorOptions) {
    this.durableSourceRunIds = new Set(options.priorEvents.flatMap((event) => (
      event.type === 'user_message' && typeof event.interjectionSourceRunId === 'string'
        ? [event.interjectionSourceRunId]
        : []
    )));
    this.modelContextSourceRunIds = new Set(this.durableSourceRunIds);
    this.announcementSourceRunIds = collectDurableInterjectionAnnouncementSourceRunIds(options.priorEvents);
    this.currentUserMessageIndex = options.currentUserMessageIndex;
  }

  requestRecoveryHandoff(reason: string): void {
    this.absorptionDisabled = true;
    const handoff = this.options.context.drainHandoff;
    if (!handoff) return;
    handoff.requested = true;
    handoff.reason = reason;
    handoff.requestedAt = new Date().toISOString();
  }

  async drain(): Promise<QueuedInterjection[]> {
    const { context } = this.options;
    if (context.signal?.aborted || this.absorptionDisabled) return [];
    const queued = await context.loadQueuedInterjections?.() ?? [];
    if (queued.length === 0 || context.signal?.aborted) return [];
    const requestedSourceRunIds = queued.map((item) => item.sourceRunId);
    let reserved = queued;
    try {
      const reservedIds = await this.options.runStore?.reserveSteeringInputs?.(
        context.runId,
        requestedSourceRunIds,
      ) ?? requestedSourceRunIds;
      const reservedSet = new Set(reservedIds);
      reserved = queued.filter((item) => reservedSet.has(item.sourceRunId));
      if (reserved.length !== queued.length) {
        const missing = queued.filter((item) => !reservedSet.has(item.sourceRunId)).map((item) => item.sourceRunId);
        this.options.warn(`[run] steering reserve partial: run=${context.runId} unreserved=${missing.join(',')}`);
      }
    } catch (error) {
      if (context.signal?.aborted) throw error;
      this.requestRecoveryHandoff('steering_reserve_failed');
      this.options.warn(`[run] steering reserve failed; handing off target run=${context.runId}: ${String(error)}`);
      return [];
    }
    if (reserved.length === 0 || context.signal?.aborted) return [];
    for (const item of reserved) {
      if (isCompactCommand(item.message.content)) this.manualCheckpointSourceRunIds.add(item.sourceRunId);
    }

    let applied = reserved;
    if (this.options.runStore?.applySteeringInputsAtomically) {
      try {
        const atomic = await this.options.runStore.applySteeringInputsAtomically(
          context.runId,
          buildAtomicSteeringInputs(reserved, this.durableSourceRunIds, context.runId, context.sessionId),
          this.options.tenantId,
        );
        const appliedSet = new Set(atomic.appliedSourceRunIds);
        applied = reserved.filter((item) => appliedSet.has(item.sourceRunId));
        await projectAtomicInterjectionEvents({
          events: atomic.events,
          durableInterjectionSourceRunIds: this.durableSourceRunIds,
          durableAnnouncementSourceRunIds: this.announcementSourceRunIds,
          transcriptProjection: this.options.transcriptProjection,
          runId: context.runId,
          warn: this.options.warn,
        });
        if (applied.length !== reserved.length) {
          this.requestRecoveryHandoff('steering_atomic_apply_partial');
          const missing = reserved.filter((item) => !appliedSet.has(item.sourceRunId)).map((item) => item.sourceRunId);
          this.options.warn(`[run] steering atomic apply partial; absorption disabled for run=${context.runId} unapplied=${missing.join(',')}`);
        }
      } catch (error) {
        if (context.signal?.aborted) throw error;
        this.requestRecoveryHandoff('steering_atomic_apply_failed');
        this.options.warn(`[run] steering atomic append/apply failed; handing off target run=${context.runId}: ${String(error)}`);
        return [];
      }
    } else {
      for (const item of reserved) {
        if (isCompactCommand(item.message.content) || this.durableSourceRunIds.has(item.sourceRunId)) continue;
        try {
          const event = await this.options.eventStore.append({
            type: 'user_message',
            runId: context.runId,
            sessionId: context.sessionId,
            content: item.message.content,
            modelContent: item.prompt,
            ...(item.attachments?.length ? { attachments: item.attachments } : {}),
            ...(item.visionAnalysis ? { visionAnalysis: item.visionAnalysis } : {}),
            interjectionSourceRunId: item.sourceRunId,
            ...(item.clientMsgId ? { clientMsgId: item.clientMsgId } : {}),
          }, { tenantId: this.options.tenantId });
          this.durableSourceRunIds.add(item.sourceRunId);
          try {
            await this.options.transcriptProjection.project(event);
          } catch (error) {
            this.options.warn(`[run] interjection transcript project failed (degraded): run=${context.runId} source=${item.sourceRunId} error=${String(error)}`);
          }
        } catch (error) {
          this.requestRecoveryHandoff('steering_reserved_event_append_failed');
          this.options.warn(`[run] steering event append failed; handing off target run=${context.runId}: ${String(error)}`);
          return [];
        }
      }
      try {
        const appliedIds = await this.options.runStore?.markSteeringInputsApplied?.(
          context.runId,
          reserved.map((item) => item.sourceRunId),
        ) ?? reserved.map((item) => item.sourceRunId);
        const appliedSet = new Set(appliedIds);
        applied = reserved.filter((item) => appliedSet.has(item.sourceRunId));
        if (applied.length !== reserved.length) {
          this.requestRecoveryHandoff('steering_reserved_apply_partial');
          const missing = reserved.filter((item) => !appliedSet.has(item.sourceRunId)).map((item) => item.sourceRunId);
          this.options.warn(`[run] steering apply partial; absorption disabled for run=${context.runId} unapplied=${missing.join(',')}`);
        }
      } catch (error) {
        if (context.signal?.aborted) throw error;
        this.requestRecoveryHandoff('steering_reserved_apply_failed');
        this.options.warn(`[run] steering apply failed; handing off target run=${context.runId}: ${String(error)}`);
        return [];
      }
    }

    for (const item of applied) {
      if (this.manualCheckpointSourceRunIds.has(item.sourceRunId) || this.modelContextSourceRunIds.has(item.sourceRunId)) continue;
      this.options.messages.push({
        role: 'user',
        content: buildModelUserContent(item.prompt, item.attachments, item.visionAnalysis),
      });
      this.currentUserMessageIndex = this.options.messages.length - 1;
      this.modelContextSourceRunIds.add(item.sourceRunId);
    }
    return applied;
  }

  announce(interjections: QueuedInterjection[]): Promise<OutboundEvent> {
    return announceAppliedInterjections({
      interjections,
      durableSourceRunIds: this.announcementSourceRunIds,
      runId: this.options.context.runId,
      sessionId: this.options.context.sessionId,
      append: this.options.append,
      warn: this.options.warn,
    });
  }
}

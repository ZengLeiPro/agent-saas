import { isCompactCommand } from '../agent/prompt.js';
import type { OutboundEvent } from '../types/index.js';
import type { LegacyTranscriptProjection } from './legacyTranscriptProjection.js';
import type { SteeringApplyInput } from './runStoreTypes.js';
import type { PlatformEvent, PlatformEventInput, QueuedInterjection } from './types.js';

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

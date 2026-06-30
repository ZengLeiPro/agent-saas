import type { InteractionResponse } from '../agent/types.js';
import type { AskUserQuestion } from '../types/index.js';
import type { PlatformEvent } from './types.js';

export type RuntimeInteractionType = 'approval' | 'ask_user' | 'permission_request';

export interface RuntimePendingInteraction {
  interactionId: string;
  type: RuntimeInteractionType;
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
  userId?: string;
  toolId?: string;
  toolName?: string;
  displayName?: string;
  questions?: AskUserQuestion[];
  toolInput?: Record<string, unknown>;
}

export function buildPendingInteractionsFromEvents(
  events: PlatformEvent[],
  sessionId: string,
): RuntimePendingInteraction[] {
  const resolved = new Set<string>();
  const requested = new Map<string, Extract<PlatformEvent, { type: 'interaction_requested' }>>();
  for (const event of events) {
    if (!('sessionId' in event) || event.sessionId !== sessionId) continue;
    if (event.type === 'interaction_resolved') {
      resolved.add(event.interactionId);
    } else if (event.type === 'interaction_requested') {
      requested.set(event.interactionId, event);
    }
  }

  const pending: RuntimePendingInteraction[] = [];
  for (const request of requested.values()) {
    if (resolved.has(request.interactionId)) continue;
    pending.push({
      interactionId: request.interactionId,
      type: request.interactionType,
      sessionId,
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      ...(request.invocationId ? { invocationId: request.invocationId } : {}),
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.toolId ? { toolId: request.toolId } : {}),
      ...(request.toolName ? { toolName: request.toolName } : {}),
      ...(request.displayName ? { displayName: request.displayName } : {}),
      ...(isAskUserQuestions(request.questions) ? { questions: request.questions } : {}),
      ...(isRecord(request.toolInput) ? { toolInput: request.toolInput } : {}),
    });
  }
  return pending;
}

export function getInteractionResolution(
  events: PlatformEvent[],
  sessionId: string,
  interactionId: string,
): Extract<PlatformEvent, { type: 'interaction_resolved' }> | null {
  return [...events].reverse().find((event): event is Extract<PlatformEvent, { type: 'interaction_resolved' }> => (
    event.type === 'interaction_resolved'
    && event.sessionId === sessionId
    && event.interactionId === interactionId
  )) ?? null;
}

export function normalizeInteractionResponse(value: unknown): InteractionResponse {
  if (!isRecord(value)) return {};
  const answers = isRecord(value.answers)
    ? Object.fromEntries(Object.entries(value.answers).filter((entry): entry is [string, string | string[]] => (
      typeof entry[1] === 'string'
      || (Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string'))
    )))
    : undefined;
  return {
    ...(typeof value.allow === 'boolean' ? { allow: value.allow } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(answers ? { answers } : {}),
  };
}

function isAskUserQuestions(value: unknown): value is AskUserQuestion[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

import type { PlatformEvent } from '../../runtime/types.js';

type InteractionRequestedCommand = Omit<
  Extract<PlatformEvent, { type: 'interaction_requested' }>,
  'id' | 'timestamp'
>;

type InteractionRequestSource = {
  type: 'ask_user' | 'permission_request';
  interactionId: string;
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
  toolId?: string;
  toolName?: string;
  displayName?: string;
  questions?: unknown;
  toolInput?: unknown;
};

export function buildInteractionRequestedCommand(args: {
  sessionId: string;
  source: InteractionRequestSource;
  revision: { version: number; order: number };
  userId?: string;
}): InteractionRequestedCommand {
  const { sessionId, source, revision, userId } = args;
  return {
    type: 'interaction_requested',
    sessionId,
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
    ...(source.invocationId ? { invocationId: source.invocationId } : {}),
    interactionId: source.interactionId,
    interactionType: source.type,
    ...revision,
    userId,
    toolId: source.toolId,
    toolName: source.toolName,
    displayName: source.displayName,
    questions: source.questions,
    toolInput: source.toolInput,
  };
}

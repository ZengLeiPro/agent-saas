import type { MessageItem } from '../types/message';
import type { InteractionState } from './interactionProtocol';
import { interactionKey } from './interactionProtocol';

/**
 * Isolated N-1 transcript adapter. It never treats a local response as an acknowledgement.
 * When ACK authority is absent, the interaction remains submitting ("待确认").
 */
export function adaptLegacyInteractionState(input: {
  sessionId: string;
  generation: number;
  message: Extract<MessageItem, { type: 'permission_request' | 'ask_user' }>;
  requestId?: string;
  response?: Record<string, unknown>;
  acknowledged?: boolean;
  authoritativeReason?: string;
}): InteractionState {
  const { sessionId, generation, message } = input;
  const base = {
    key: interactionKey(sessionId, message.interactionId),
    sessionId,
    interactionId: message.interactionId,
    generation,
  };
  const terminal = message.type === 'permission_request'
    ? message.status === 'allowed' || message.status === 'denied'
    : message.status === 'answered';
  if (terminal && input.acknowledged) {
    return {
      ...base,
      phase: message.type === 'permission_request' && message.status === 'denied' ? 'rejected' : 'resolved',
      response: input.response,
      requestId: input.requestId,
      reason: input.authoritativeReason,
      retryable: false,
      serverAuthoritative: true,
    };
  }
  if (input.requestId || input.response) {
    return {
      ...base,
      phase: 'submitting',
      response: input.response,
      requestId: input.requestId,
      reason: '待服务器确认',
      retryable: false,
      serverAuthoritative: false,
    };
  }
  return {
    ...base,
    phase: 'pending',
    retryable: true,
    serverAuthoritative: terminal && input.acknowledged === true,
  };
}

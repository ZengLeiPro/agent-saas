import type { AskUserAnswers } from '../types/message';
import type { WsEvent } from '../types/ws';
import type { MessagesController } from './wsEventProcessorHelpers';

type InteractionResponse = Extract<WsEvent, { type: 'interaction_resolved' }>['response'];

/** Apply a canonical interaction outcome without inventing decisions for legacy broadcasts. */
export function applyInteractionResolution(
  messages: MessagesController,
  index: number,
  response: InteractionResponse,
): void {
  const current = messages.messagesRef.current[index];
  if (current.type === 'permission_request' && current.status === 'pending') {
    if (typeof response?.allow !== 'boolean') return;
    messages.updateMessageAt(index, (message) => message.type === 'permission_request'
      ? { ...message, status: response.allow ? 'allowed' : 'denied' }
      : message);
    return;
  }
  const answers = response?.answers;
  if (current.type === 'ask_user' && current.status === 'pending'
    && answers && typeof answers === 'object' && !Array.isArray(answers)) {
    messages.updateMessageAt(index, (message) => message.type === 'ask_user'
      ? { ...message, status: 'answered', answers: answers as AskUserAnswers }
      : message);
  }
}

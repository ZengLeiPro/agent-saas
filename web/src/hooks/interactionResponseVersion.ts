import type { MessageItem } from '@/components/types';
import { authFetch } from '@/lib/authFetch';

interface PendingInteractionVersion {
  interactionId: string;
  version: number;
  order: number;
}

/** Resolve the server revision before responding; legacy/versionless live cards are hydrated in the same click. */
export async function hydrateInteractionVersion(
  sessionId: string,
  interactionId: string,
  getMessages: () => MessageItem[],
  setMessages: (messages: MessageItem[], options?: { scrollToBottom?: boolean }) => void,
): Promise<number | null> {
  const messages = getMessages();
  const existing = messages.find(
    (message) =>
      (message.type === 'permission_request' || message.type === 'ask_user') &&
      message.interactionId === interactionId,
  ) as Extract<MessageItem, { type: 'permission_request' | 'ask_user' }> | undefined;
  if (Number.isSafeInteger(existing?.interactionVersion)) return existing!.interactionVersion!;

  const response = await authFetch(
    `/api/chat/interactions/pending?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) return null;
  const pending = (await response.json()) as PendingInteractionVersion[];
  const canonical = pending.find((item) => item.interactionId === interactionId);
  if (!canonical || !Number.isSafeInteger(canonical.version)) return null;
  const latestMessages = getMessages();
  const stillPending = latestMessages.some(
    (message) =>
      (message.type === 'permission_request' || message.type === 'ask_user') &&
      message.interactionId === interactionId &&
      message.status === 'pending',
  );
  if (!stillPending) return null;
  setMessages(
    latestMessages.map((message) =>
      (message.type === 'permission_request' || message.type === 'ask_user') &&
      message.interactionId === interactionId &&
      message.status === 'pending'
        ? { ...message, interactionVersion: canonical.version, interactionOrder: canonical.order }
        : message,
    ),
    { scrollToBottom: false },
  );
  return canonical.version;
}

/**
 * Chat md+ right-slot opener (preview / file / future browser).
 * Phone callers see `openFilePreview` return false and keep stack push.
 */
import { createContext, useContext } from 'react';

export type ChatRightFilePreviewRequest = {
  route: '/chat/markdown-preview' | '/files/preview';
  filePath: string;
  name?: string;
  size?: number;
  modifiedAt?: number;
};

export type ChatRightSlotContextValue = {
  /**
   * md+: consume into SideOverlayPanel and return true.
   * phone / no host: return false so the caller `router.push`es.
   */
  openFilePreview: (request: ChatRightFilePreviewRequest) => boolean;
};

const ChatRightSlotContext = createContext<ChatRightSlotContextValue | null>(null);

export const ChatRightSlotProvider = ChatRightSlotContext.Provider;

export function useChatRightSlot(): ChatRightSlotContextValue | null {
  return useContext(ChatRightSlotContext);
}

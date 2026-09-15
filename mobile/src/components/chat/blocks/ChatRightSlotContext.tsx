/**
 * Chat md+ right-slot opener (preview / file / artifact / future browser).
 * Phone callers see open* return false and keep stack push / download paths.
 */
import { createContext, useContext } from 'react';

export type ChatRightFilePreviewRequest = {
  route: '/chat/markdown-preview' | '/files/preview';
  filePath: string;
  name?: string;
  size?: number;
  modifiedAt?: number;
};

export type ChatRightArtifactPreviewRequest = {
  artifactId: string;
  fileName: string;
  fileSize?: number;
};

export type ChatRightSlotContextValue = {
  /**
   * md+: consume into SideOverlayPanel and return true.
   * phone / no host: return false so the caller `router.push`es.
   */
  openFilePreview: (request: ChatRightFilePreviewRequest) => boolean;
  /**
   * md+: open ArtifactPreviewPane in the single right slot.
   * phone / no host: return false so FileDownloadCard keeps download/share.
   * Never embeds HTML; download-only / html viewKinds show a safe notice.
   */
  openArtifactPreview: (request: ChatRightArtifactPreviewRequest) => boolean;
};

const ChatRightSlotContext = createContext<ChatRightSlotContextValue | null>(null);

export const ChatRightSlotProvider = ChatRightSlotContext.Provider;

export function useChatRightSlot(): ChatRightSlotContextValue | null {
  return useContext(ChatRightSlotContext);
}

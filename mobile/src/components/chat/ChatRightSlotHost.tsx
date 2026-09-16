/**
 * Single chat right-slot host (overlay or docked). Keeps ChatSessionScreen under max-lines.
 */
import React from 'react';
import { SideOverlayPanel, type SideOverlayPresentation } from '../layout';
import { FilePreviewBody, filePreviewDisplayName } from '../files/preview/FilePreviewBody';
import { ArtifactPreviewPane } from './ArtifactPreviewPane';
import { ChatFileBrowserPane } from './ChatFileBrowserPane';
import { MarkdownPreviewBody, markdownPreviewTitle } from './MarkdownPreviewBody';
import { SubagentTranscriptSheet } from './SubagentTranscriptSheet';
import type {
  ChatRightArtifactPreviewRequest,
  ChatRightFilePreviewRequest,
  SubagentTranscriptTarget,
} from './blocks';

export type ChatRightSlotHostProps = {
  presentation: SideOverlayPresentation | null;
  width: number;
  docked: boolean;
  overlay: boolean;
  onResizeDelta?: (delta: number) => void;
  onResizeEnd?: () => void;
  transcriptTarget: SubagentTranscriptTarget | null;
  onCloseTranscript: () => void;
  rightPreview: ChatRightFilePreviewRequest | null;
  onClosePreview: () => void;
  onNavigateMarkdown: (filePath: string) => void;
  rightArtifact: ChatRightArtifactPreviewRequest | null;
  onCloseArtifact: () => void;
  fileBrowserOpen: boolean;
  onCloseFileBrowser: () => void;
  sessionOwner?: string;
  onOpenPreviewFromBrowser: (request: ChatRightFilePreviewRequest) => void;
};

export function ChatRightSlotHost({
  presentation,
  width,
  docked,
  overlay,
  onResizeDelta,
  onResizeEnd,
  transcriptTarget,
  onCloseTranscript,
  rightPreview,
  onClosePreview,
  onNavigateMarkdown,
  rightArtifact,
  onCloseArtifact,
  fileBrowserOpen,
  onCloseFileBrowser,
  sessionOwner,
  onOpenPreviewFromBrowser,
}: ChatRightSlotHostProps) {
  if (!presentation) return null;

  const frame = {
    width,
    presentation,
    resizable: docked,
    onResizeDelta: docked ? onResizeDelta : undefined,
    onResizeEnd: docked ? onResizeEnd : undefined,
    dimmed: overlay,
  };

  if (transcriptTarget) {
    return (
      <SideOverlayPanel
        title={`子任务完整过程 · ${transcriptTarget.title}`}
        subtitle={transcriptTarget.childSessionId}
        onClose={onCloseTranscript}
        testID="chat-right-subagent"
        {...frame}
      >
        <SubagentTranscriptSheet
          visible
          variant="body"
          childSessionId={transcriptTarget.childSessionId}
          title={transcriptTarget.title}
          onClose={onCloseTranscript}
        />
      </SideOverlayPanel>
    );
  }

  if (rightArtifact) {
    return (
      <SideOverlayPanel
        title={rightArtifact.fileName}
        onClose={onCloseArtifact}
        testID="chat-right-artifact"
        {...frame}
      >
        <ArtifactPreviewPane
          artifactId={rightArtifact.artifactId}
          fileName={rightArtifact.fileName}
          fileSize={rightArtifact.fileSize}
        />
      </SideOverlayPanel>
    );
  }

  if (rightPreview?.route === '/chat/markdown-preview') {
    return (
      <SideOverlayPanel
        title={markdownPreviewTitle(rightPreview.filePath)}
        onClose={onClosePreview}
        testID="chat-right-preview"
        {...frame}
      >
        <MarkdownPreviewBody
          filePath={rightPreview.filePath}
          {...(sessionOwner ? { owner: sessionOwner } : {})}
          onNavigatePreview={onNavigateMarkdown}
        />
      </SideOverlayPanel>
    );
  }

  if (rightPreview?.route === '/files/preview') {
    return (
      <SideOverlayPanel
        title={filePreviewDisplayName(rightPreview.filePath, rightPreview.name)}
        onClose={onClosePreview}
        testID="chat-right-file-preview"
        {...frame}
      >
        <FilePreviewBody
          filePath={rightPreview.filePath}
          name={rightPreview.name}
          size={rightPreview.size ?? 0}
          modifiedAt={rightPreview.modifiedAt ?? 0}
          {...(sessionOwner ? { owner: sessionOwner } : {})}
        />
      </SideOverlayPanel>
    );
  }

  if (fileBrowserOpen) {
    return (
      <SideOverlayPanel
        title="文件"
        onClose={onCloseFileBrowser}
        testID="chat-right-file-browser"
        {...frame}
      >
        <ChatFileBrowserPane owner={sessionOwner} onOpenPreview={onOpenPreviewFromBrowser} />
      </SideOverlayPanel>
    );
  }

  return null;
}

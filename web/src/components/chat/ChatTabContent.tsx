import { type Ref, type MutableRefObject } from "react";
import { Trash2 } from "lucide-react";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { TtsProps } from "@/components/MessageItem";
import type { TtsState } from "@/hooks/useTtsPlayer";
import type { ModelList } from "@/types/models";
import type { AgentProfile, SessionParticipants } from "@agent/shared";
import { MessageList } from "@/components/MessageList";
import { FileUpload } from "@/components/FileUpload";
import { ChatInput } from "@/components/ChatInput";

interface ChatTabContentProps {
  messages: MessageItem[];
  loading: boolean;
  isLoadingMessages?: boolean;
  lastMessageRef: Ref<HTMLDivElement>;
  scrollContainerRef: Ref<HTMLDivElement>;
  isNearBottomRef?: MutableRefObject<boolean>;
  onPermissionResponse?: (interactionId: string, allow: boolean) => void;
  onAskUserResponse?: (interactionId: string, answers: Record<string, string>) => void;
  onRetry?: (message: MessageItem) => void;
  onFork?: (message: MessageItem) => void;
  uploadedFiles: UploadedFile[];
  onRemoveFile: (index: number) => void;
  input: string;
  uploading: boolean;
  uploadError?: string | null;
  onDismissUploadError?: () => void;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onPaste?: (event: React.ClipboardEvent) => void;
  tts?: TtsProps;
  ttsStateMap?: Record<string, TtsState>;
  modelList?: ModelList | null;
  selectedModel?: string | null;
  sessionId?: string | null;
  onModelChange?: (ref: string) => void;
  canAutoApproveRunShell?: boolean;
  autoApproveRunShell?: boolean;
  onAutoApproveRunShellChange?: (checked: boolean) => void;
  onSendVoice?: (wavBlob: Blob, durationMs: number) => Promise<void>;
  readOnly?: boolean;
  agentProfile?: AgentProfile | null;
  sessionParticipants?: SessionParticipants | null;
  /** 空会话槽位（透传给 MessageList）：新会话空白态展示的内容，如场景推荐卡 */
  emptySlot?: React.ReactNode;
}

export function ChatTabContent({
  messages,
  loading,
  isLoadingMessages,
  lastMessageRef,
  scrollContainerRef,
  isNearBottomRef,
  onPermissionResponse,
  onAskUserResponse,
  onRetry,
  onFork,
  uploadedFiles,
  onRemoveFile,
  input,
  uploading,
  uploadError,
  onDismissUploadError,
  onInputChange,
  onSend,
  onStop,
  stopping,
  onFileSelect,
  onPaste,
  tts,
  ttsStateMap,
  modelList,
  selectedModel,
  sessionId,
  onModelChange,
  canAutoApproveRunShell,
  autoApproveRunShell,
  onAutoApproveRunShellChange,
  onSendVoice,
  readOnly,
  agentProfile,
  sessionParticipants,
  emptySlot,
}: ChatTabContentProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MessageList
        lastMessageRef={lastMessageRef}
        scrollContainerRef={scrollContainerRef}
        isNearBottomRef={isNearBottomRef}
        messages={messages}
        loading={loading}
        isLoadingMessages={isLoadingMessages}
        onPermissionResponse={readOnly ? undefined : onPermissionResponse}
        onAskUserResponse={readOnly ? undefined : onAskUserResponse}
        onRetry={readOnly ? undefined : onRetry}
        onFork={readOnly ? undefined : onFork}
        tts={tts}
        ttsStateMap={ttsStateMap}
        agentProfile={agentProfile}
        sessionParticipants={sessionParticipants}
        emptySlot={readOnly ? undefined : emptySlot}
      />

      <div className="shrink-0">
        {readOnly ? (
          <div className="flex items-center justify-center gap-2 border-t bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            <Trash2 className="h-4 w-4" />
            正在预览已删除的会话（只读）
          </div>
        ) : (
          <>
            <FileUpload
              uploadedFiles={uploadedFiles}
              uploading={uploading}
              uploadError={uploadError}
              onRemoveFile={onRemoveFile}
              onDismissError={onDismissUploadError}
            />
            <ChatInput
              input={input}
              loading={loading}
              uploading={uploading}
              hasUploadedFiles={uploadedFiles.length > 0}
              onInputChange={onInputChange}
              onSend={onSend}
              onStop={onStop}
              stopping={stopping}
              onFileSelect={onFileSelect}
              onPaste={onPaste}
              scrollContainerRef={scrollContainerRef as React.RefObject<HTMLDivElement>}
              isNearBottomRef={isNearBottomRef}
              modelList={modelList}
              selectedModel={selectedModel}
              sessionId={sessionId}
              onModelChange={onModelChange}
              canAutoApproveRunShell={canAutoApproveRunShell}
              autoApproveRunShell={autoApproveRunShell}
              onAutoApproveRunShellChange={onAutoApproveRunShellChange}
              onSendVoice={onSendVoice}
            />
          </>
        )}
      </div>
    </div>
  );
}

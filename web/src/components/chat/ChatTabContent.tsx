import { type Ref, type MutableRefObject, useMemo } from "react";
import { Trash2 } from "lucide-react";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { TtsProps } from "@/components/MessageItem";
import type { TtsState } from "@/hooks/useTtsPlayer";
import type { ModelList } from "@/types/models";
import type { AskUserAnswers } from "@agent/shared";
import type { AgentProfile, SessionParticipants } from "@agent/shared";
import { MessageList } from "@/components/MessageList";
import { FileUpload } from "@/components/FileUpload";
import { ChatInput } from "@/components/ChatInput";
import { TodoPanel } from "@/components/TodoPanel";
import { AskUserPromptPanel } from "@/components/AskUserPromptPanel";

interface ChatTabContentProps {
  messages: MessageItem[];
  loading: boolean;
  isLoadingMessages?: boolean;
  lastMessageRef: Ref<HTMLDivElement>;
  scrollContainerRef: Ref<HTMLDivElement>;
  isNearBottomRef?: MutableRefObject<boolean>;
  onPermissionResponse?: (interactionId: string, allow: boolean) => void;
  onAskUserResponse?: (interactionId: string, answers: AskUserAnswers) => void;
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
  readOnlyInputPlaceholder?: string;
  debugModeOverride?: boolean;
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
  readOnlyInputPlaceholder,
  debugModeOverride,
  agentProfile,
  sessionParticipants,
  emptySlot,
}: ChatTabContentProps) {
  const activeAskUser = useMemo(() => {
    if (readOnly) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.type === "ask_user" && message.status === "pending") {
        return message;
      }
    }
    return null;
  }, [messages, readOnly]);

  const visibleMessages = useMemo(() => {
    if (!activeAskUser) return messages;
    return messages.filter((message) => message.id !== activeAskUser.id);
  }, [activeAskUser, messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MessageList
        lastMessageRef={lastMessageRef}
        scrollContainerRef={scrollContainerRef}
        isNearBottomRef={isNearBottomRef}
        messages={visibleMessages}
        loading={activeAskUser ? false : loading}
        isLoadingMessages={isLoadingMessages}
        onPermissionResponse={readOnly ? undefined : onPermissionResponse}
        onAskUserResponse={readOnly ? undefined : onAskUserResponse}
        onRetry={readOnly ? undefined : onRetry}
        onFork={readOnly ? undefined : onFork}
        tts={tts}
        ttsStateMap={ttsStateMap}
        agentProfile={agentProfile}
        sessionParticipants={sessionParticipants}
        debugModeOverride={debugModeOverride}
        emptySlot={readOnly ? undefined : emptySlot}
      />

      <div className="shrink-0">
        {readOnly && readOnlyInputPlaceholder ? (
          <ChatInput
            input=""
            loading={false}
            uploading={false}
            hasUploadedFiles={false}
            onInputChange={() => undefined}
            onSend={() => undefined}
            onFileSelect={() => undefined}
            scrollContainerRef={scrollContainerRef as React.RefObject<HTMLDivElement>}
            isNearBottomRef={isNearBottomRef}
            modelList={modelList}
            selectedModel={selectedModel}
            sessionId={sessionId}
            onModelChange={onModelChange}
            canAutoApproveRunShell={canAutoApproveRunShell}
            autoApproveRunShell={autoApproveRunShell}
            onAutoApproveRunShellChange={onAutoApproveRunShellChange}
            disabled
            disabledPlaceholder={readOnlyInputPlaceholder}
          />
        ) : readOnly ? (
          <div className="flex items-center justify-center gap-2 border-t bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            <Trash2 className="h-4 w-4" />
            正在预览已删除的会话（只读）
          </div>
        ) : (
          <>
            <TodoPanel messages={messages} sessionId={sessionId} runActive={loading && !stopping} />
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
              topSlot={activeAskUser ? (
                <AskUserPromptPanel
                  key={activeAskUser.interactionId}
                  questions={activeAskUser.questions}
                  onSubmit={(answers) => onAskUserResponse?.(activeAskUser.interactionId, answers)}
                />
              ) : undefined}
            />
          </>
        )}
      </div>
    </div>
  );
}

import { type Ref, type MutableRefObject, useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { OrgAgentAvatarContent } from "@/components/OrgAgentAvatar";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { TtsProps } from "@/components/MessageItem";
import type { TtsState } from "@/hooks/useTtsPlayer";
import type { ModelList } from "@/types/models";
import type { AskUserAnswers } from "@agent/shared";
import type { AgentProfile, OrgAgentSummary, SessionParticipants } from "@agent/shared";
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
  /** 当前企业专家（包含未发送草稿态）；缺省 = 个人通用 Agent。 */
  orgAgent?: OrgAgentSummary | null;
  /** 当前企业专家的新对话入口；只读/停用会话不提供。 */
  onNewOrgAgentConversation?: () => void;
  /** 前往专家列表选择另一位专家。 */
  onSwitchOrgAgent?: () => void;
}

export function OrgAgentComposerChip({
  orgAgent,
  onNewConversation,
  onSwitch,
}: {
  orgAgent: OrgAgentSummary;
  onNewConversation?: () => void;
  onSwitch?: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-50 text-base dark:bg-brand-900/35" aria-hidden="true">
        <OrgAgentAvatarContent agent={orgAgent} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{orgAgent.name}</span>
        <span className="block truncate">企业专家{orgAgent.skillCount > 0 ? ` · ${orgAgent.skillCount} 个固有技能` : ""}</span>
      </span>
      {onNewConversation && (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-brand-600 transition-colors hover:bg-brand-50 dark:hover:bg-brand-900/35"
          onClick={onNewConversation}
          title={`使用${orgAgent.name}发起新对话`}
          aria-label={`使用${orgAgent.name}发起新对话`}
        >
          <Plus className="h-3.5 w-3.5" />
          新对话
        </button>
      )}
      {onSwitch && (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onSwitch}
        >
          切换
        </button>
      )}
    </div>
  );
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
  orgAgent,
  onNewOrgAgentConversation,
  onSwitchOrgAgent,
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

  const displayAgentProfile = useMemo<AgentProfile | null | undefined>(() => {
    if (!orgAgent) return agentProfile;
    return {
      username: `org-agent:${orgAgent.id}`,
      name: orgAgent.name,
      ...(orgAgent.avatar ? { avatar: orgAgent.avatar } : {}),
      ...(orgAgent.avatarVersion ? { avatarVersion: orgAgent.avatarVersion } : {}),
      updatedAt: "",
      updatedBy: "organization",
    };
  }, [agentProfile, orgAgent]);

  const displaySessionParticipants = useMemo<SessionParticipants | null | undefined>(() => {
    if (!orgAgent || !sessionParticipants) return sessionParticipants;
    return { ...sessionParticipants, agent: displayAgentProfile ?? null };
  }, [displayAgentProfile, orgAgent, sessionParticipants]);

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
        agentProfile={displayAgentProfile}
        sessionParticipants={displaySessionParticipants}
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
              topSlot={(orgAgent || activeAskUser) ? (
                <div className="space-y-2">
                  {orgAgent && (
                    <OrgAgentComposerChip
                      orgAgent={orgAgent}
                      onNewConversation={onNewOrgAgentConversation}
                      onSwitch={onSwitchOrgAgent}
                    />
                  )}
                  {activeAskUser && (
                    <AskUserPromptPanel
                      key={activeAskUser.interactionId}
                      questions={activeAskUser.questions}
                      onSubmit={(answers) => onAskUserResponse?.(activeAskUser.interactionId, answers)}
                    />
                  )}
                </div>
              ) : undefined}
            />
          </>
        )}
      </div>
    </div>
  );
}

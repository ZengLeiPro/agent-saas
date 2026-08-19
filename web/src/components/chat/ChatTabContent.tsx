import { type Ref, type MutableRefObject, useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { OrgAgentAvatarContent } from "@/components/OrgAgentAvatar";
import { cn } from "@/lib/utils";
import type { MessageItem, UploadedFile } from "@/components/types";
import type { TtsProps } from "@/components/MessageItem";
import type { TtsState } from "@/hooks/useTtsPlayer";
import type { ModelList } from "@/types/models";
import type { AskUserAnswers } from "@agent/shared";
import type { AgentProfile, OrgAgentSummary, SessionParticipants } from "@agent/shared";
import { MessageList } from "@/components/MessageList";
import { FileUpload } from "@/components/FileUpload";
import { ChatInput } from "@/components/ChatInput";
import { AskUserPromptPanel } from "@/components/AskUserPromptPanel";
import { QueuedMessageBar } from "@/components/QueuedMessageBar";
import type { QueuedInterjection } from "@/hooks/useChatAppState";

interface ChatTabContentProps {
  messages: MessageItem[];
  loading: boolean;
  isLoadingMessages?: boolean;
  hasMoreHistory?: boolean;
  isLoadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
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
  onInterject?: () => void;
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
  /** 空会话推荐内容；初始 composer 模式下显示在输入框下方，否则透传给 MessageList。 */
  emptySlot?: React.ReactNode;
  /** 是否启用居中的初始会话 composer；不可用/只读状态保持原布局。 */
  initialComposer?: boolean;
  /** 当前企业专家（包含未发送草稿态）；缺省 = 个人通用 Agent。 */
  orgAgent?: OrgAgentSummary | null;
  /** 当前企业专家的新对话入口；只读/停用会话不提供。 */
  onNewOrgAgentConversation?: () => void;
  /** 前往专家列表选择另一位专家。 */
  onSwitchOrgAgent?: () => void;
  /** 插话队列区（2026-08-04 终态设计）：运行中发送的消息在输入框上方排队展示 */
  queuedInterjections?: QueuedInterjection[];
  onCancelQueuedInterjection?: (clientMsgId: string) => Promise<boolean>;
  onEditQueuedInterjection?: (clientMsgId: string) => Promise<void>;
  onResendQueuedInterjection?: (clientMsgId: string) => void;
  onDismissQueuedInterjection?: (clientMsgId: string) => void;
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
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-50 text-base dark:bg-brand-900/35" aria-hidden="true">
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
          <Plus className="size-3.5" />
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

function InitialConversationHeader({
  agentProfile,
  orgAgent,
  compact,
}: {
  agentProfile?: AgentProfile | null;
  orgAgent?: OrgAgentSummary | null;
  compact: boolean;
}) {
  const agentName = orgAgent?.name || agentProfile?.name || "开沿 Agent";

  return (
    <div className="content-container flex flex-col items-center pb-2 text-center sm:pb-3">
      <div className="mb-3 inline-flex items-center gap-2 rounded-full border bg-card px-2 py-1 text-xs font-medium text-muted-foreground sm:mb-4">
        {orgAgent ? (
          <span className="flex size-7 items-center justify-center overflow-hidden rounded-lg bg-brand-50 text-base dark:bg-brand-900/35" aria-hidden="true">
            <OrgAgentAvatarContent agent={orgAgent} />
          </span>
        ) : (
          <AgentAvatar
            avatar={agentProfile?.avatar}
            username={agentProfile?.username}
            version={agentProfile?.avatarVersion}
            size={28}
            className="rounded-lg"
          />
        )}
        <span className="text-foreground">{agentName}</span>
        <span>{orgAgent ? "· 企业专家" : "· 个人 Agent"}</span>
      </div>
      <h1 className="text-[28px] font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">
        {orgAgent ? `要让${orgAgent.name}处理什么？` : "今天先推进哪件事？"}
      </h1>
      <div className={cn(
        "grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out",
        compact ? "mt-0 grid-rows-[0fr] opacity-0" : "mt-2 grid-rows-[1fr] opacity-100 sm:mt-3",
      )}>
        <p className="max-w-2xl overflow-hidden text-sm leading-6 text-muted-foreground">
          {orgAgent
            ? orgAgent.description || "它会在组织配置的职责和数据权限内完成工作。"
            : "直接描述目标，或从一个开箱任务开始。"}
        </p>
      </div>
    </div>
  );
}

export function ChatTabContent({
  messages,
  loading,
  isLoadingMessages,
  hasMoreHistory,
  isLoadingEarlier,
  onLoadEarlier,
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
  onInterject,
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
  initialComposer = false,
  orgAgent,
  onNewOrgAgentConversation,
  onSwitchOrgAgent,
  queuedInterjections,
  onCancelQueuedInterjection,
  onEditQueuedInterjection,
  onResendQueuedInterjection,
  onDismissQueuedInterjection,
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

  const hasQueuedInterjections = Boolean(queuedInterjections?.length);
  const hasComposerDraft = Boolean(input.trim())
    || uploadedFiles.length > 0
    || uploading
    || Boolean(uploadError);
  const isInitialConversation = initialComposer
    && !readOnly
    && !isLoadingMessages
    && messages.length === 0
    && !loading
    && !activeAskUser
    && !hasQueuedInterjections;
  const showInitialSuggestions = isInitialConversation && !hasComposerDraft && Boolean(emptySlot);
  const initialPlaceholder = orgAgent
    ? `交代目标、范围和希望${orgAgent.name}交付的结果`
    : "说清目标，我来拆解并推进";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          "flex min-h-0 basis-0 overflow-hidden transition-[flex-grow,opacity] duration-300 ease-out",
          isInitialConversation ? "pointer-events-none grow-0 opacity-0" : "grow opacity-100",
        )}
      >
        <MessageList
          lastMessageRef={lastMessageRef}
          scrollContainerRef={scrollContainerRef}
          isNearBottomRef={isNearBottomRef}
          messages={visibleMessages}
          loading={activeAskUser ? false : loading}
          isLoadingMessages={isLoadingMessages}
          hasMoreHistory={hasMoreHistory}
          isLoadingEarlier={isLoadingEarlier}
          onLoadEarlier={onLoadEarlier}
          onPermissionResponse={readOnly ? undefined : onPermissionResponse}
          onAskUserResponse={readOnly ? undefined : onAskUserResponse}
          onRetry={readOnly ? undefined : onRetry}
          onFork={readOnly ? undefined : onFork}
          tts={tts}
          ttsStateMap={ttsStateMap}
          agentProfile={displayAgentProfile}
          sessionParticipants={displaySessionParticipants}
          debugModeOverride={debugModeOverride}
          emptySlot={readOnly || initialComposer ? undefined : emptySlot}
        />
      </div>

      {readOnly && readOnlyInputPlaceholder ? (
        <div className="shrink-0">
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
        </div>
      ) : readOnly ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Trash2 className="size-4" />
          正在预览已删除的会话（只读）
        </div>
      ) : (
        <div
          data-initial-conversation={isInitialConversation ? "true" : "false"}
          className={cn(
            "flex min-h-0 flex-col justify-center transition-[flex-grow,padding] duration-300 ease-out",
            isInitialConversation ? "grow overflow-y-auto overscroll-y-contain py-6 sm:py-10" : "shrink-0 grow-0",
          )}
        >
          <div className="w-full">
            {initialComposer && (
              <div className={cn(
                "grid transition-[grid-template-rows,opacity,transform] duration-300 ease-out",
                isInitialConversation
                  ? "grid-rows-[1fr] translate-y-0 opacity-100"
                  : "grid-rows-[0fr] translate-y-2 opacity-0",
              )}>
                <div className="overflow-hidden">
                  <InitialConversationHeader
                    agentProfile={agentProfile}
                    orgAgent={orgAgent}
                    compact={hasComposerDraft}
                  />
                </div>
              </div>
            )}

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
              onInterject={onInterject}
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
              placeholder={isInitialConversation ? initialPlaceholder : undefined}
              topSlot={((orgAgent && !isInitialConversation) || activeAskUser || hasQueuedInterjections) ? (
                <div className="space-y-2">
                  {orgAgent && !isInitialConversation && (
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
                  {queuedInterjections && queuedInterjections.length > 0
                    && onCancelQueuedInterjection && onEditQueuedInterjection
                    && onResendQueuedInterjection && onDismissQueuedInterjection && (
                    <QueuedMessageBar
                      entries={queuedInterjections}
                      onCancel={onCancelQueuedInterjection}
                      onEdit={onEditQueuedInterjection}
                      onResend={onResendQueuedInterjection}
                      onDismiss={onDismissQueuedInterjection}
                    />
                  )}
                </div>
              ) : undefined}
            />

            {initialComposer && (
              <div
                aria-hidden={!showInitialSuggestions}
                className={cn(
                  "grid transition-[grid-template-rows,opacity,transform] duration-200 ease-out",
                  showInitialSuggestions
                    ? "grid-rows-[1fr] translate-y-0 opacity-100"
                    : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0",
                )}
              >
                <div className="overflow-hidden">{emptySlot}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

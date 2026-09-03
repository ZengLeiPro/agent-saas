import { type Ref, type MutableRefObject, useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { PermissionBlock } from "@/components/PermissionBlock";
import { QueuedMessageBar } from "@/components/QueuedMessageBar";
import type { QueuedInterjection } from "@/hooks/useChatAppState";
import type { SandboxProfile } from "@/types/sandboxProfile";

interface ChatTabContentProps {
  messages: MessageItem[];
  loading: boolean;
  isLoadingMessages?: boolean;
  sessionLoadError?: string | null;
  onRetrySessionLoad?: () => void;
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
  sandboxProfile?: SandboxProfile;
  onSandboxProfileChange?: (profile: SandboxProfile) => void;
  uploading: boolean;
  uploadError?: string | null;
  onDismissUploadError?: () => void;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onAssetSelect?: (paths: string[]) => Promise<void> | void;
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
  businessStepDetailMode?: 'desktop' | 'mobile';
  businessStepDetailHost?: HTMLElement | null;
  businessStepPanelOpen?: boolean;
  onBusinessStepPanelOpenChange?: (open: boolean) => void;
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
}: {
  agentProfile?: AgentProfile | null;
  orgAgent?: OrgAgentSummary | null;
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
    </div>
  );
}

export function ChatTabContent({
  messages,
  loading,
  isLoadingMessages,
  sessionLoadError,
  onRetrySessionLoad,
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
  sandboxProfile = "daily",
  onSandboxProfileChange,
  uploading,
  uploadError,
  onDismissUploadError,
  onInputChange,
  onSend,
  onStop,
  stopping,
  onFileSelect,
  onAssetSelect,
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
  businessStepDetailMode,
  businessStepDetailHost,
  businessStepPanelOpen,
  onBusinessStepPanelOpenChange,
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
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const handleSwitchModel = useCallback(() => setModelSelectorOpen(true), []);
  useEffect(() => setModelSelectorOpen(false), [sessionId]);

  const pendingInteractions = useMemo(() => messages
    .filter((message): message is Extract<MessageItem, { type: 'ask_user' | 'permission_request' }> =>
      (message.type === 'ask_user' || message.type === 'permission_request') && message.status === 'pending')
    .sort((left, right) => (left.interactionOrder ?? Number.MAX_SAFE_INTEGER) - (right.interactionOrder ?? Number.MAX_SAFE_INTEGER)
      || (left.interactionVersion ?? 0) - (right.interactionVersion ?? 0)
      || left.interactionId.localeCompare(right.interactionId)), [messages]);
  const activeInteraction = pendingInteractions[0] ?? null;
  const activeAskUser = activeInteraction?.type === 'ask_user' ? activeInteraction : null;
  const activePermission = activeInteraction?.type === 'permission_request' ? activeInteraction : null;

  // Pending interactions live exclusively in the fixed composer zone. Terminal receipts may remain in history.
  const visibleMessages = useMemo(() => messages.filter((message) => !(
    (message.type === 'ask_user' || message.type === 'permission_request') && message.status === 'pending'
  )), [messages]);

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
    && !sessionLoadError
    && messages.length === 0
    && !loading
    && !activeInteraction
    && !hasQueuedInterjections;
  const showInitialSuggestions = isInitialConversation && !hasComposerDraft && Boolean(emptySlot);
  const initialPlaceholder = orgAgent
    ? `交代目标、范围和希望${orgAgent.name}交付的结果`
    : "说清目标，我来拆解并推进";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          "relative flex min-h-0 basis-0 overflow-hidden transition-[flex-grow,opacity] duration-300 ease-out",
          isInitialConversation ? "pointer-events-none grow-0 opacity-0" : "grow opacity-100",
        )}
      >
        <MessageList
          lastMessageRef={lastMessageRef}
          scrollContainerRef={scrollContainerRef}
          isNearBottomRef={isNearBottomRef}
          messages={visibleMessages}
          loading={activeInteraction ? false : loading}
          isLoadingMessages={isLoadingMessages}
          hasMoreHistory={hasMoreHistory}
          isLoadingEarlier={isLoadingEarlier}
          onLoadEarlier={onLoadEarlier}
          onPermissionResponse={readOnly ? undefined : onPermissionResponse}
          onAskUserResponse={readOnly ? undefined : onAskUserResponse}
          onRetry={readOnly ? undefined : onRetry}
          onSwitchModel={readOnly ? undefined : handleSwitchModel}
          onFork={readOnly ? undefined : onFork}
          tts={tts}
          ttsStateMap={ttsStateMap}
          agentProfile={displayAgentProfile}
          sessionParticipants={displaySessionParticipants}
          sessionId={readOnly ? undefined : sessionId}
          debugModeOverride={debugModeOverride}
          businessStepDetailMode={businessStepDetailMode}
          businessStepDetailHost={businessStepDetailHost}
          businessStepPanelOpen={businessStepPanelOpen}
          onBusinessStepPanelOpenChange={onBusinessStepPanelOpenChange}
          emptySlot={sessionLoadError ? (
            <div role="alert" className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{sessionLoadError}</p>
                <p className="text-xs text-muted-foreground">无需刷新页面，可直接重新加载当前会话。</p>
              </div>
              {onRetrySessionLoad && (
                <button
                  type="button"
                  onClick={onRetrySessionLoad}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <RefreshCw className="size-3.5" />
                  重新加载
                </button>
              )}
            </div>
          ) : readOnly || initialComposer ? undefined : emptySlot}
        />
        {sessionLoadError && messages.length > 0 && (
          <div role="alert" className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-md backdrop-blur">
            <span>{sessionLoadError}</span>
            {onRetrySessionLoad && (
              <button type="button" onClick={onRetrySessionLoad} className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground">
                <RefreshCw className="size-3" />
                重试
              </button>
            )}
          </div>
        )}
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
            sandboxProfile={sandboxProfile}
            onSandboxProfileChange={onSandboxProfileChange}
            onModelChange={onModelChange}
            modelSelectorOpen={modelSelectorOpen}
            onModelSelectorOpenChange={setModelSelectorOpen}
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
            isInitialConversation ? "initial-conversation-content grow overflow-y-auto overscroll-y-contain py-6 sm:py-10" : "shrink-0 grow-0",
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
              onStop={onStop}
              stopping={stopping}
              onFileSelect={onFileSelect}
              onAssetSelect={onAssetSelect}
              onPaste={onPaste}
              scrollContainerRef={scrollContainerRef as React.RefObject<HTMLDivElement>}
              isNearBottomRef={isNearBottomRef}
              modelList={modelList}
              selectedModel={selectedModel}
              sessionId={sessionId}
              sandboxProfile={sandboxProfile}
              onSandboxProfileChange={onSandboxProfileChange}
              onModelChange={onModelChange}
              modelSelectorOpen={modelSelectorOpen}
              onModelSelectorOpenChange={setModelSelectorOpen}
              canAutoApproveRunShell={canAutoApproveRunShell}
              autoApproveRunShell={autoApproveRunShell}
              onAutoApproveRunShellChange={onAutoApproveRunShellChange}
              onSendVoice={onSendVoice}
              placeholder={isInitialConversation ? initialPlaceholder : undefined}
              topSlot={((orgAgent && !isInitialConversation) || activeInteraction || hasQueuedInterjections) ? (
                <div className="space-y-2">
                  {orgAgent && !isInitialConversation && (
                    <OrgAgentComposerChip
                      orgAgent={orgAgent}
                      onNewConversation={onNewOrgAgentConversation}
                      onSwitch={onSwitchOrgAgent}
                    />
                  )}
                  {activeAskUser && (
                    <div aria-label="待回答问题" data-interaction-zone="canonical">
                      <AskUserPromptPanel
                        key={activeAskUser.interactionId}
                        questions={activeAskUser.questions}
                        onSubmit={(answers) => { if (!readOnly) onAskUserResponse?.(activeAskUser.interactionId, answers); }}
                      />
                    </div>
                  )}
                  {activePermission && (
                    <div aria-label="待处理权限请求" data-interaction-zone="canonical">
                      <PermissionBlock
                        key={activePermission.interactionId}
                        toolName={activePermission.toolName}
                        toolInput={activePermission.toolInput}
                        status="pending"
                        disabled={readOnly}
                        onAllow={() => { if (!readOnly) onPermissionResponse?.(activePermission.interactionId, true); }}
                        onDeny={() => { if (!readOnly) onPermissionResponse?.(activePermission.interactionId, false); }}
                      />
                    </div>
                  )}
                  {pendingInteractions.length > 1 ? <p className="px-1 text-xs text-muted-foreground">另有 {pendingInteractions.length - 1} 个交互按服务端顺序排队</p> : null}
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
                data-initial-suggestions={showInitialSuggestions ? "visible" : "hidden"}
                aria-hidden={!showInitialSuggestions}
                className={cn(
                  "grid transition-[grid-template-rows,opacity,transform] duration-200 ease-out",
                  showInitialSuggestions
                    ? "grid-rows-[1fr] translate-y-0 opacity-100"
                    : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0",
                )}
              >
                <div className="overflow-hidden">{showInitialSuggestions ? emptySlot : null}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

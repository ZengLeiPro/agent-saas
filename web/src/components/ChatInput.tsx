import { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { Plus, ArrowUp, Square, Mic, Loader2, StopCircle, ChevronDown } from "lucide-react";

import AttachmentControls from "@/components/AttachmentControls";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { warmupSessionSandbox } from "@/lib/sessionsApi";
import type { ModelList } from "@/types/models";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { SandboxProfile } from "@/types/sandboxProfile";

interface ChatInputProps {
  input: string;
  loading?: boolean;
  uploading: boolean;
  hasUploadedFiles: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  /** 当前 run 运行时显式插话；普通发送按钮只加入串行队列。 */
  onInterject?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAssetSelect?: (paths: string[]) => Promise<void> | void;
  onPaste?: (e: React.ClipboardEvent) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
  isNearBottomRef?: React.MutableRefObject<boolean>;
  modelList?: ModelList | null;
  selectedModel?: string | null;
  sessionId?: string | null;
  sandboxProfile?: SandboxProfile;
  onSandboxProfileChange?: (profile: SandboxProfile) => void;
  onModelChange?: (ref: string) => void;
  modelSelectorOpen?: boolean;
  onModelSelectorOpenChange?: (open: boolean) => void;
  canAutoApproveRunShell?: boolean;
  autoApproveRunShell?: boolean;
  onAutoApproveRunShellChange?: (checked: boolean) => void;
  onSendVoice?: (wavBlob: Blob, durationMs: number) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  disabledPlaceholder?: string;
  topSlot?: React.ReactNode;
  attachedTopSlot?: React.ReactNode;
}

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 200;
const warmedSessionIds = new Set<string>();

function warmupSessionOnce(sessionId: string | null | undefined, value: string): void {
  if (!sessionId || warmedSessionIds.has(sessionId) || !value.trim()) return;
  warmedSessionIds.add(sessionId);
  void warmupSessionSandbox(sessionId).catch(() => undefined);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function ChatInput({
  input,
  loading,
  uploading,
  hasUploadedFiles,
  onInputChange,
  onSend,
  onInterject,
  onStop,
  stopping,
  onFileSelect,
  onAssetSelect,
  onPaste,
  scrollContainerRef,
  isNearBottomRef,
  modelList,
  selectedModel,
  sessionId,
  sandboxProfile = "daily",
  onSandboxProfileChange,
  onModelChange,
  modelSelectorOpen,
  onModelSelectorOpenChange,
  canAutoApproveRunShell,
  autoApproveRunShell,
  onAutoApproveRunShellChange,
  onSendVoice,
  disabled,
  placeholder = "输入消息...",
  disabledPlaceholder = "只读状态无法发送消息",
  topSlot,
  attachedTopSlot,
}: ChatInputProps) {
  const isDisabled = disabled === true;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const localFileInputRef = useRef<HTMLInputElement>(null);
  const [tooShortTip, setTooShortTip] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);

  const voiceRecorder = useVoiceRecorder({
    onVoiceSend: async (wavBlob, durationMs) => {
      if (isDisabled) return;
      await onSendVoice?.(wavBlob, durationMs);
    },
    onTooShort: () => {
      setTooShortTip(true);
      setTimeout(() => setTooShortTip(false), 2000);
    },
  });

  /** 自动调整 textarea 高度 */
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${MIN_HEIGHT}px`;
    const next = Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [input, adjustHeight]);

  // 通过 visualViewport resize 检测键盘弹出/收起
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let prevKeyboard = false;

    const onResize = () => {
      const isKeyboard = vv.height < window.innerHeight - 100;

      if (isKeyboard !== prevKeyboard) {
        prevKeyboard = isKeyboard;
        if (wrapperRef.current) {
          wrapperRef.current.style.paddingBottom = isKeyboard ? "0px" : "var(--sab)";
        }

        if (isKeyboard) {
          requestAnimationFrame(() => {
            if (isNearBottomRef?.current !== false && scrollContainerRef?.current) {
              scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
            }
          });
        }
      }
    };

    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, [scrollContainerRef]);

  const handleFocus = useCallback(() => {
    if (isDisabled) return;
    setTimeout(() => {
      if (isNearBottomRef?.current !== false && scrollContainerRef?.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    }, 350);
  }, [scrollContainerRef, isNearBottomRef, isDisabled]);

  // IME composition 跨浏览器处理：
  // Chrome: keydown(isComposing=true) → compositionend — isComposing 可靠
  // Safari: compositionend → keydown(isComposing=false) — isComposing 不可靠
  // 用 ref 手动跟踪 composition 状态，compositionend 延迟清除以覆盖 Safari 的 keydown
  const isComposingRef = useRef(false);

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    const value = event.currentTarget.value;
    setTimeout(() => {
      isComposingRef.current = false;
      warmupSessionOnce(sessionId, value);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isDisabled) return;
    if (e.nativeEvent.isComposing || isComposingRef.current) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const hasContent = !!input.trim() || hasUploadedFiles;
  const showStop = !!loading && (!hasContent || !!stopping) && !!onStop;
  const disableAttach = uploading || isDisabled;
  const attachmentDisabled = disableAttach || voiceRecorder.isRecording;
  const showVoice = !isDisabled && !!onSendVoice && voiceRecorder.isSupported;

  // 会话已开始时锁定组
  const lockedGroupId = useMemo(() => {
    if (!sessionId || !selectedModel || !modelList || modelList.allowCrossGroupSwitch) {
      return null;
    }
    const slashIdx = selectedModel.indexOf('/');
    return slashIdx >= 0 ? selectedModel.slice(0, slashIdx) : null;
  }, [sessionId, selectedModel, modelList]);

  const selectedModelName = useMemo(() => {
    if (!modelList || !selectedModel) return null;
    const slashIdx = selectedModel.indexOf('/');
    if (slashIdx < 0) return null;
    const groupId = selectedModel.slice(0, slashIdx);
    const modelId = selectedModel.slice(slashIdx + 1);
    const group = modelList.groups.find((g) => g.id === groupId);
    const model = group?.models.find((m) => m.id === modelId);
    return model?.name ?? null;
  }, [modelList, selectedModel]);

  const selectableModelGroups = useMemo(() => {
    if (!modelList) return [];
    return modelList.groups.filter((g) => !lockedGroupId || g.id === lockedGroupId);
  }, [modelList, lockedGroupId]);

  const profileLocked = !!sessionId || isDisabled || loading;
  const profileLabel = sandboxProfile === "coding" ? "编程" : "日常";
  const handleProfileKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (profileLocked) return;
    let next: SandboxProfile | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home") next = "daily";
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End") next = "coding";
    if (!next) return;
    event.preventDefault();
    onSandboxProfileChange?.(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-profile="${next}"]`)?.focus();
  }, [onSandboxProfileChange, profileLocked]);

  const handleMicClick = useCallback(async () => {
    if (isDisabled) return;
    try {
      const granted = await voiceRecorder.ensurePermission();
      if (!granted) {
        alert('无法访问麦克风，请检查浏览器权限设置。');
        return;
      }
      await voiceRecorder.startRecording();
    } catch (err) {
      console.error('[Voice] startRecording failed:', err);
      alert('录音启动失败，请重试。');
    }
  }, [isDisabled, voiceRecorder.ensurePermission, voiceRecorder.startRecording]);

  const renderVoiceButton = () => {
    if (!showVoice || voiceRecorder.isRecording || loading) return null;

    return (
      <button
        type="button"
        onClick={handleMicClick}
        className="flex size-8 shrink-0 items-center justify-center text-foreground transition-opacity hover:opacity-70 active:opacity-50"
        title="语音输入"
        aria-label="语音输入"
      >
        <Mic className="size-5" />
      </button>
    );
  };

  // 右侧主按钮：loading/stopping → stop → recording → send
  const renderRightButton = () => {
    if (isDisabled) {
      return (
        <button
          type="button"
          disabled
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted-foreground/10 text-muted-foreground cursor-not-allowed"
          title={disabledPlaceholder}
          aria-label={disabledPlaceholder}
        >
          <ArrowUp className="size-5" strokeWidth={2.5} />
        </button>
      );
    }
    if (loading && stopping) {
      return (
        <button
          type="button"
          disabled
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted-foreground/10 text-muted-foreground cursor-not-allowed"
          title="正在停止..."
        >
          <Loader2 className="size-3.5 animate-spin" />
        </button>
      );
    }
    if (showStop) {
      return (
        <button
          type="button"
          onTouchEnd={(e) => { e.preventDefault(); onStop!(); }}
          onClick={() => onStop!()}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted-foreground/20 text-foreground transition-opacity hover:opacity-80 active:opacity-70"
          title="停止生成"
        >
          <Square className="size-3.5" fill="currentColor" />
        </button>
      );
    }
    if (voiceRecorder.isRecording) {
      return (
        <button
          type="button"
          onClick={voiceRecorder.stopAndSend}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-80 active:opacity-70"
          title="停止录音并发送"
        >
          <StopCircle className="size-5" />
        </button>
      );
    }
    if (hasContent) {
      return (
        <button
          type="button"
          onTouchEnd={(e) => { e.preventDefault(); onSend(); }}
          onClick={onSend}
          disabled={uploading}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
            "hover:opacity-80 active:opacity-70",
            "disabled:pointer-events-none disabled:opacity-40",
          )}
          title={loading ? "加入队列" : "发送消息"}
          aria-label={loading ? "加入队列" : "发送消息"}
        >
          <ArrowUp className="size-5" strokeWidth={2.5} />
        </button>
      );
    }
    return (
      <button
        type="button"
        disabled
        className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center rounded-full bg-muted text-muted-foreground/40"
        title="发送消息"
        aria-label="发送消息"
      >
        <ArrowUp className="size-5" strokeWidth={2.5} />
      </button>
    );
  };

  return (
    <>
      {topSlot && (
        <div className="bg-transparent">
          <div className="content-container pt-3">
            {topSlot}
          </div>
        </div>
      )}

      <div
        ref={wrapperRef}
        className="bg-transparent"
        style={{ paddingBottom: "var(--sab)" }}
      >
        <div className="content-container pt-3 pb-1">
          {attachedTopSlot}
          <div
            className="relative z-10 flex flex-col rounded-[24px] border border-border bg-card shadow-sm"
            onClick={() => !isDisabled && !voiceRecorder.isRecording && textareaRef.current?.focus()}
          >
            {/* 文本输入区 / 录音指示器 */}
            {voiceRecorder.isRecording ? (
              <div className="flex items-center gap-3 px-4 py-3">
                {/* 录音红点脉冲 */}
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
                </span>
                {/* 时长 */}
                <span className="text-sm font-mono tabular-nums text-foreground flex-1">
                  {formatDuration(voiceRecorder.duration)}
                </span>
                {/* 取消按钮 */}
                <button
                  type="button"
                  onClick={voiceRecorder.cancelRecording}
                  className="text-xs text-destructive hover:text-destructive/80 transition-colors"
                >
                  取消
                </button>
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                aria-label="消息输入"
                autoComplete="off"
                value={input}
                onChange={(e) => {
                  if (isDisabled) return;
                  const value = e.target.value;
                  onInputChange(value);
                  if (!isComposingRef.current) warmupSessionOnce(sessionId, value);
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onPaste={isDisabled ? undefined : onPaste}
                onFocus={handleFocus}
                enterKeyHint="send"
                placeholder={isDisabled ? disabledPlaceholder : hasUploadedFiles ? "附件已添加，输入消息..." : placeholder}
                rows={1}
                disabled={isDisabled}
                className={cn(
                  "w-full bg-transparent px-4 pt-3.5 pb-2 text-sm",
                  "placeholder:text-muted-foreground/60",
                  "focus:outline-none",
                  "disabled:cursor-not-allowed disabled:text-foreground disabled:placeholder:text-muted-foreground/60",
                  "resize-none"
                )}
                style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT, overflowY: "hidden" }}
              />
            )}

            {/* 底部工具栏 */}
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-0.5">
                <Popover open={attachmentMenuOpen} onOpenChange={setAttachmentMenuOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full border border-border text-foreground transition-colors",
                        "hover:bg-muted-foreground/10 active:bg-muted-foreground/20",
                        attachmentDisabled
                          ? "cursor-not-allowed opacity-40"
                          : "cursor-pointer",
                      )}
                      aria-label="添加附件"
                      disabled={attachmentDisabled}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Plus className="size-5" />
                    </button>
                  </PopoverTrigger>
                  {attachmentMenuOpen && (
                    <AttachmentControls
                      onLocalFile={() => {
                        setAttachmentMenuOpen(false);
                        localFileInputRef.current?.click();
                      }}
                      onMenuOpenChange={setAttachmentMenuOpen}
                      onAssetConfirm={onAssetSelect}
                      disabled={attachmentDisabled}
                    />
                  )}
                </Popover>
                <input
                  ref={localFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={onFileSelect}
                  disabled={attachmentDisabled}
                />
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      disabled={profileLocked}
                      aria-label={`运行环境：${profileLabel}`}
                      title={profileLocked ? `当前会话使用${profileLabel}环境` : "选择运行环境"}
                      className={cn(
                        "ml-1 flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors",
                        "hover:bg-muted-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        profileLocked && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <span>{profileLabel}</span>
                      <ChevronDown className="size-3.5" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" sideOffset={8} className="w-36 rounded-xl p-1.5 shadow-xl">
                    <div className="px-2.5 pb-1 pt-1 text-[11px] text-muted-foreground">运行环境</div>
                    <div role="radiogroup" aria-label="运行环境" onKeyDown={handleProfileKeyDown}>
                      {([
                        { value: "daily" as const, label: "日常" },
                        { value: "coding" as const, label: "编程" },
                      ]).map((option) => {
                        const checked = sandboxProfile === option.value;
                        return (
                          <PopoverClose asChild key={option.value}>
                            <button
                              type="button"
                              role="radio"
                              data-profile={option.value}
                              aria-checked={checked}
                              tabIndex={checked ? 0 : -1}
                              onClick={() => {
                                if (!profileLocked) onSandboxProfileChange?.(option.value);
                              }}
                              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                            >
                              <span className="w-3.5 shrink-0 text-center text-xs text-muted-foreground" aria-hidden="true">
                                {checked ? "●" : "○"}
                              </span>
                              <span>{option.label}</span>
                            </button>
                          </PopoverClose>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="flex items-center gap-1">
                {/* 录音时间太短提示 */}
                {tooShortTip && (
                  <span className="text-xs text-destructive mr-1">说话时间太短</span>
                )}

                {/* 本次会话工具自动批准 */}
                {canAutoApproveRunShell && onAutoApproveRunShellChange && !voiceRecorder.isRecording && (
                  <div
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground",
                    )}
                    title="自动批准工具授权"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="hidden sm:inline">自动授权工具</span>
                    <Switch
                      checked={!!autoApproveRunShell}
                      onCheckedChange={onAutoApproveRunShellChange}
                      disabled={isDisabled}
                      aria-label="自动授权工具"
                    />
                  </div>
                )}

                {/* 模型选择器 */}
                {modelList && selectedModel && onModelChange && !voiceRecorder.isRecording && (
                  <Select
                    value={selectedModel}
                    onValueChange={onModelChange}
                    open={modelSelectorOpen}
                    onOpenChange={onModelSelectorOpenChange}
                    disabled={isDisabled}
                  >
                    <SelectTrigger
                      className={cn(
                        "inline-flex h-7 w-auto items-center gap-1 rounded-md px-2",
                        "text-xs text-muted-foreground",
                        "hover:bg-muted-foreground/10 focus:ring-0",
                      )}
                      style={{ border: "none", background: "transparent", boxShadow: "none", outline: "none" }}
                    >
                      <SelectValue>{selectedModelName ?? selectedModel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent side="top" align="center">
                      {modelList.showGroupNames ? (
                        selectableModelGroups.map((group) => (
                          <SelectGroup key={group.id}>
                            <SelectLabel className="pl-2 text-xs">{group.name}</SelectLabel>
                            {group.models.map((m) => (
                              <SelectItem key={`${group.id}/${m.id}`} value={`${group.id}/${m.id}`}>
                                {m.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))
                      ) : (
                        selectableModelGroups.flatMap((group) => group.models.map((m) => (
                          <SelectItem key={`${group.id}/${m.id}`} value={`${group.id}/${m.id}`}>
                            {m.name}
                          </SelectItem>
                        )))
                      )}
                    </SelectContent>
                  </Select>
                )}

                {renderVoiceButton()}
                {loading && hasContent && onInterject && !stopping && (
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); onInterject(); }}
                    className="h-8 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title="在当前 Agent 的下一个安全边界插话"
                    aria-label="立即插话"
                  >
                    立即插话
                  </button>
                )}
                {renderRightButton()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

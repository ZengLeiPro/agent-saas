import { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { Plus, ArrowUp, Square, Mic, Loader2, StopCircle } from "lucide-react";

import { cn } from "@/lib/utils";
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

interface ChatInputProps {
  input: string;
  loading?: boolean;
  uploading: boolean;
  hasUploadedFiles: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
  isNearBottomRef?: React.MutableRefObject<boolean>;
  modelList?: ModelList | null;
  selectedModel?: string | null;
  sessionId?: string | null;
  onModelChange?: (ref: string) => void;
  canAutoApproveRunShell?: boolean;
  autoApproveRunShell?: boolean;
  onAutoApproveRunShellChange?: (checked: boolean) => void;
  onSendVoice?: (wavBlob: Blob, durationMs: number) => Promise<void>;
  disabled?: boolean;
  disabledPlaceholder?: string;
  topSlot?: React.ReactNode;
  attachedTopSlot?: React.ReactNode;
}

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 200;

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
  onStop,
  stopping,
  onFileSelect,
  onPaste,
  scrollContainerRef,
  isNearBottomRef,
  modelList,
  selectedModel,
  sessionId,
  onModelChange,
  canAutoApproveRunShell,
  autoApproveRunShell,
  onAutoApproveRunShellChange,
  onSendVoice,
  disabled,
  disabledPlaceholder = "只读状态无法发送消息",
  topSlot,
  attachedTopSlot,
}: ChatInputProps) {
  const isDisabled = disabled === true;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [tooShortTip, setTooShortTip] = useState(false);

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

  const handleCompositionEnd = () => {
    setTimeout(() => { isComposingRef.current = false; }, 0);
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
          title="发送消息"
          aria-label="发送消息"
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
                autoComplete="off"
                value={input}
                onChange={(e) => {
                  if (!isDisabled) onInputChange(e.target.value);
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onPaste={isDisabled ? undefined : onPaste}
                onFocus={handleFocus}
                enterKeyHint="send"
                placeholder={isDisabled ? disabledPlaceholder : hasUploadedFiles ? "附件已添加，输入消息..." : "输入消息..."}
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
                <label
                  className={cn(
                    "relative flex size-8 items-center justify-center overflow-hidden rounded-full border border-border text-foreground transition-colors",
                    "hover:bg-muted-foreground/10 active:bg-muted-foreground/20",
                    disableAttach || voiceRecorder.isRecording
                      ? "cursor-not-allowed opacity-40"
                      : "cursor-pointer",
                  )}
                  title="添加附件"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Plus className="size-5" />
                  <input
                    type="file"
                    multiple
                    className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                    onChange={onFileSelect}
                    accept="*/*"
                    disabled={disableAttach || voiceRecorder.isRecording}
                    aria-label="添加附件"
                  />
                </label>
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
                  <Select value={selectedModel} onValueChange={onModelChange} disabled={isDisabled}>
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
                {renderRightButton()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

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
}

const MIN_HEIGHT = 36;
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
}: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [tooShortTip, setTooShortTip] = useState(false);

  const voiceRecorder = useVoiceRecorder({
    onVoiceSend: async (wavBlob, durationMs) => {
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
    setTimeout(() => {
      if (isNearBottomRef?.current !== false && scrollContainerRef?.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    }, 350);
  }, [scrollContainerRef, isNearBottomRef]);

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
    if (e.nativeEvent.isComposing || isComposingRef.current) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const hasContent = !!input.trim() || hasUploadedFiles;
  const showStop = !!loading && (!hasContent || !!stopping) && !!onStop;
  const disableAttach = uploading;
  const showVoice = !!onSendVoice && voiceRecorder.isSupported;

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
  }, [voiceRecorder.ensurePermission, voiceRecorder.startRecording]);

  // 右侧按钮：loading/stopping → stop → recording → hasContent → send → mic/send
  const renderRightButton = () => {
    if (loading && stopping) {
      return (
        <button
          type="button"
          disabled
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted-foreground/10 text-muted-foreground cursor-not-allowed"
          title="正在停止..."
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </button>
      );
    }
    if (showStop) {
      return (
        <button
          type="button"
          onTouchEnd={(e) => { e.preventDefault(); onStop!(); }}
          onClick={() => onStop!()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted-foreground/20 text-foreground transition-opacity hover:opacity-80 active:opacity-70"
          title="停止生成"
        >
          <Square className="h-3.5 w-3.5" fill="currentColor" />
        </button>
      );
    }
    if (voiceRecorder.isRecording) {
      return (
        <button
          type="button"
          onClick={voiceRecorder.stopAndSend}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-80 active:opacity-70"
          title="停止录音并发送"
        >
          <StopCircle className="h-5 w-5" />
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
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
            "hover:opacity-80 active:opacity-70",
            "disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
        </button>
      );
    }
    // 无内容：显示 mic（如支持）或 send
    if (showVoice) {
      return (
        <button
          type="button"
          onClick={handleMicClick}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20 active:bg-muted-foreground/30"
          title="语音输入"
        >
          <Mic className="h-5 w-5" />
        </button>
      );
    }
    return (
      <button
        type="button"
        onTouchEnd={(e) => { e.preventDefault(); onSend(); }}
        onClick={onSend}
        disabled={uploading}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
          "hover:opacity-80 active:opacity-70",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
      </button>
    );
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        multiple
        style={{ display: 'none' }}
        onChange={onFileSelect}
        accept="*/*"
      />

      <div
        ref={wrapperRef}
        className="border-t border-border bg-secondary"
        style={{ paddingBottom: "var(--sab)" }}
      >
        <div className="content-container pt-3 pb-1">
          <div
            className="flex flex-col rounded-lg bg-card shadow-sm"
            onClick={() => !voiceRecorder.isRecording && textareaRef.current?.focus()}
          >
            {/* 文本输入区 / 录音指示器 */}
            {voiceRecorder.isRecording ? (
              <div className="flex items-center gap-3 px-4 py-3">
                {/* 录音红点脉冲 */}
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
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
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onPaste={onPaste}
                onFocus={handleFocus}
                enterKeyHint="send"
                placeholder={hasUploadedFiles ? "附件已添加，输入消息..." : "输入消息..."}
                rows={1}
                className={cn(
                  "w-full bg-transparent px-4 pt-3 pb-1 text-sm",
                  "placeholder:text-muted-foreground/60",
                  "focus:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  "resize-none"
                )}
                style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT, overflowY: "hidden" }}
              />
            )}

            {/* 底部工具栏 */}
            <div className="flex items-center justify-between px-2 pb-2 pt-1">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disableAttach || voiceRecorder.isRecording}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors",
                    "hover:bg-muted-foreground/10 active:bg-muted-foreground/20",
                    "disabled:pointer-events-none disabled:opacity-40",
                  )}
                  title="添加附件"
                >
                  <Plus className="h-5 w-5" />
                </button>
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
                      aria-label="自动授权工具"
                    />
                  </div>
                )}

                {/* 模型选择器 */}
                {modelList && selectedModel && onModelChange && !voiceRecorder.isRecording && (
                  <Select value={selectedModel} onValueChange={onModelChange}>
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

                {renderRightButton()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { mapSessionDetailToMessages, type ApiSessionDetail, type ApiTranscriptBlock } from "@agent/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/MessageList";
import { ResizablePanelDivider } from "@/components/ResizablePanelDivider";
import { FilePreviewProvider } from "@/contexts/FilePreviewContext";
import { HTML_SANDBOX_CSP } from "@/components/HtmlPreviewPanel";
import { SystemPanel } from "@/components/SystemPanel";
import { useResizePanel } from "@/hooks/useResizePanel";
import { useSystemPanel } from "@/hooks/useSystemPanel";
import { ActionIcons, EntityIcons, StatusIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { ReplayScript } from "./types";

const ApprovalIcon = EntityIcons.admin;
const ApprovalSuccessIcon = StatusIcons.success;
const UndoIcon = ActionIcons.undo;

/** 模拟真实模型流式输出：短回答逐字，长回答按小块输出，单条约 1～3 秒。 */
const DEFAULT_TYPEWRITER_INTERVAL_MS = 24;
const TYPEWRITER_TARGET_TICKS = 120;

function splitText(content: string): string[] {
  return Array.from(content);
}

function typewriterChunkSize(length: number): number {
  return Math.max(1, Math.ceil(length / TYPEWRITER_TARGET_TICKS));
}

/**
 * 场景演示回放视图。
 *
 * 中间区走真实的 mapSessionDetailToMessages → MessageList → MessageItem →
 * ToolBlock 路径，**并强制 debugModeOverride={false}**，与普通客户完全同构。
 * 这是本批次的验收标准：演示里能看到的每一个像素，普通客户在真实会话里
 * 遇到同类数据时也能看到——不允许存在「只有演示看得到」的视图。
 *
 * 底部回放条本身即演示状态的标识，不额外加提示文案。
 */

function buildDetail(blocks: ApiTranscriptBlock[]): ApiSessionDetail {
  return {
    sessionId: "scenario-replay",
    stats: { lines: blocks.length, parsedLines: blocks.length, parseErrors: 0 },
    blocks,
  };
}

/** 产物预览：数据源来自剧本，渲染与沙箱策略与真实 HTML 产物预览一致。 */
function ArtifactPanel({ html, fileName, onClose, onBackToPanel }: { html: string; fileName: string; onClose: () => void; onBackToPanel?: () => void }) {
  const srcDoc = useMemo(
    () => html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">`),
    [html],
  );
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {onBackToPanel ? (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onBackToPanel}>
            <ChevronLeft className="size-3.5" />
            系统实况
          </Button>
        ) : null}
        <span className="min-w-0 truncate text-sm font-medium">{fileName}</span>
        <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={onClose} aria-label="关闭产物预览">
          <X className="size-4" />
        </Button>
      </div>
      <iframe
        title={fileName}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}

export function ScenarioReplayView({
  script,
  onExit,
  typewriterIntervalMs = DEFAULT_TYPEWRITER_INTERVAL_MS,
}: {
  script: ReplayScript;
  onExit: () => void;
  /** 测试可缩短间隔；生产默认模拟真实模型流式输出速度。 */
  typewriterIntervalMs?: number;
}) {
  // 首屏只显示用户发来的信息；由用户主动推进后，才展示第一步 Agent 输出。
  const [stepIndex, setStepIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<number, "approved" | "rejected">>({});
  const [artifact, setArtifact] = useState<{ path: string; fileName: string } | null>(null);
  const [streamedTextLengths, setStreamedTextLengths] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const total = script.steps.length;
  const atEnd = stepIndex >= total;
  const currentStepIndex = stepIndex - 1;
  const currentStep = currentStepIndex >= 0 ? script.steps[currentStepIndex] : undefined;
  const currentDecision = currentStepIndex >= 0 ? decisions[currentStepIndex] : undefined;

  const visibleBlocks = useMemo(() => {
    if (stepIndex === 0) {
      return script.steps[0]?.blocks.filter((block) => block.kind === "prompt") ?? [];
    }
    return script.steps.slice(0, stepIndex).flatMap((step, index) => [
      ...step.blocks,
      ...(decisions[index] === "approved" ? step.approval?.approvedBlocks ?? [] : []),
      // 退回同样有下文：客户要看到"退回之后系统怎么处理"，而不是一个死按钮
      ...(decisions[index] === "rejected" ? step.approval?.rejectedBlocks ?? [] : []),
    ]);
  }, [decisions, script, stepIndex]);

  const typewriterEnabled = typewriterIntervalMs > 0;
  const activeTextBlock = useMemo(() => {
    if (!typewriterEnabled) return null;
    for (const block of visibleBlocks) {
      if (block.kind !== "text") continue;
      const length = splitText(block.content).length;
      if ((streamedTextLengths[block.id] ?? 0) < length) return block;
    }
    return null;
  }, [streamedTextLengths, typewriterEnabled, visibleBlocks]);
  const isStreaming = activeTextBlock !== null;
  const gateBlocked = isStreaming || (!!currentStep?.approval && currentDecision !== "approved");

  useEffect(() => {
    if (!activeTextBlock) return;
    const characters = splitText(activeTextBlock.content);
    const timer = window.setTimeout(() => {
      setStreamedTextLengths((current) => {
        const nextLength = Math.min(
          characters.length,
          (current[activeTextBlock.id] ?? 0) + typewriterChunkSize(characters.length),
        );
        if (nextLength === current[activeTextBlock.id]) return current;
        return { ...current, [activeTextBlock.id]: nextLength };
      });
    }, typewriterIntervalMs);
    return () => window.clearTimeout(timer);
  }, [activeTextBlock, streamedTextLengths, typewriterIntervalMs]);

  const messages = useMemo(() => {
    const blocks = visibleBlocks.map((block) => {
      if (block.kind !== "text") return block;
      const characters = splitText(block.content);
      const visibleLength = typewriterEnabled
        ? Math.min(characters.length, streamedTextLengths[block.id] ?? 0)
        : characters.length;
      return {
        ...block,
        content: characters.slice(0, visibleLength).join(""),
        // 结构化展示块在正文完成后再出现，贴近真实流式事件的到达顺序。
        ...(visibleLength < characters.length ? { display: undefined } : {}),
      };
    });
    const mapped = blocks.length ? mapSessionDetailToMessages(buildDetail(blocks)) : [];
    return mapped.map((message) => (
      message.type === "text" && message.id === activeTextBlock?.id
        ? { ...message, streaming: true }
        : message
    ));
  }, [activeTextBlock?.id, streamedTextLengths, typewriterEnabled, visibleBlocks]);

  // 面板从消息流 fold，与真实会话同一个 hook——面板没有独立数据通道
  const { snapshot, selectView } = useSystemPanel(messages);
  const artifactHtml = artifact ? script.artifacts?.[artifact.path] : undefined;
  const rightOpen = !!snapshot || !!artifactHtml;
  const {
    ratio: splitRatio,
    containerRef: splitContainerRef,
    onDividerMouseDown,
    onDividerDoubleClick,
  } = useResizePanel(0.3, 0.25, 0.5);

  const next = useCallback(() => {
    if (gateBlocked) return;
    setStepIndex((i) => Math.min(total, i + 1));
  }, [gateBlocked, total]);
  const prev = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
    setArtifact(null);
  }, []);
  const reset = useCallback(() => {
    setStepIndex(0);
    setDecisions({});
    setArtifact(null);
    setStreamedTextLengths({});
  }, []);

  const approveCurrentStep = useCallback(() => {
    if (isStreaming || !currentStep?.approval) return;
    setDecisions((current) => ({ ...current, [currentStepIndex]: "approved" }));
    setStepIndex((i) => Math.min(total, i + 1));
  }, [currentStep?.approval, currentStepIndex, isStreaming, total]);

  const rejectCurrentStep = useCallback(() => {
    if (isStreaming || !currentStep?.approval) return;
    setDecisions((current) => ({ ...current, [currentStepIndex]: "rejected" }));
  }, [currentStep?.approval, currentStepIndex, isStreaming]);

  const reopenReview = useCallback(() => {
    setDecisions((current) => {
      const nextDecisions = { ...current };
      delete nextDecisions[currentStepIndex];
      return nextDecisions;
    });
  }, [currentStepIndex]);

  // 与客户演示稿一致：空格 / → 推进，← 回退。禁止自动播放，全程由讲述者控速。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  // 推进或流式吐字时滚到底，模拟真实会话的跟随行为。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const openPreview = useCallback(
    (filePath: string) => {
      if (!script.artifacts?.[filePath]) return;
      setArtifact({ path: filePath, fileName: filePath.split("/").pop() || filePath });
    },
    [script.artifacts],
  );

  const downloadFile = useCallback(
    (filePath: string, fileName: string) => {
      const html = script.artifacts?.[filePath];
      if (!html) return;
      const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [script.artifacts],
  );

  const caption = atEnd ? "演示结束" : script.steps[stepIndex]?.caption ?? "";

  return (
    // h-full 而非 flex-1：父级 TabsContent 是普通块、不是 flex 容器，
    // flex-1 在那里不生效，会导致消息区高度塌陷、回放条被顶到页面上方
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onExit} className="gap-1 px-2">
          <ChevronLeft className="size-4" />
          返回
        </Button>
        <h2 className="min-w-0 truncate text-sm font-medium">{script.title}</h2>
        <Badge variant="secondary" className="ml-auto shrink-0 font-normal">
          {script.mode === "hero" ? "完整业务闭环" : "快速体验"}
        </Badge>
      </div>

      <div ref={rightOpen ? splitContainerRef : undefined} className="flex min-h-0 flex-1">
        {/* 默认保持会话区更宽；右侧看板的拖拽交互与正式会话复用同一个 useResizePanel。 */}
        <div
          data-scenario-replay-conversation
          className={cn("flex min-h-0 flex-col", rightOpen ? "min-w-0" : "w-full")}
          style={rightOpen ? {
            flexBasis: `${(1 - splitRatio) * 100}%`,
            flexShrink: 0,
            flexGrow: 0,
          } : undefined}
        >
          <FilePreviewProvider value={{ openPreview, downloadFile }}>
            <MessageList
              messages={messages}
              loading={false}
              isLoadingMessages={false}
              scrollContainerRef={scrollRef}
              debugModeOverride={false}
            />
            {currentStep?.approval && currentDecision !== "approved" ? (
              <div className="shrink-0 border-t border-border bg-amber-50/60 px-4 py-3">
                <div className="mx-auto max-w-3xl rounded-xl border border-amber-200 bg-background p-4 shadow-sm">
                  {currentDecision === "rejected" ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-2">
                        <UndoIcon className="mt-0.5 size-4 shrink-0 text-amber-700" />
                        <div>
                          <div className="text-sm font-medium">已退回修改，未写入业务系统</div>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            当前流程停在审核点。重新提交后，仍需再次明确批准。
                          </p>
                        </div>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={reopenReview}>重新提交审核</Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start gap-2">
                        <ApprovalIcon className="mt-0.5 size-4 shrink-0 text-amber-700" />
                        <div>
                          <div className="text-sm font-medium">{currentStep.approval.title}</div>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">{currentStep.approval.description}</p>
                        </div>
                      </div>
                      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                        {currentStep.approval.facts.map((fact) => (
                          <div key={`${fact.label}-${fact.value}`} className="rounded-lg border bg-muted/30 px-3 py-2">
                            <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                            <dd className="mt-0.5 text-sm font-medium">{fact.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <div className="mt-3 flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={rejectCurrentStep} disabled={isStreaming}>
                          {currentStep.approval.rejectLabel ?? "退回修改"}
                        </Button>
                        <Button type="button" size="sm" className="gap-1" onClick={approveCurrentStep} disabled={isStreaming}>
                          <ApprovalSuccessIcon className="size-4" />
                          {currentStep.approval.approveLabel}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </FilePreviewProvider>

          {/* 回放控制替代真实输入框，只占会话列，并复用输入框的居中宽度。 */}
          <div className="shrink-0 bg-background" style={{ paddingBottom: "var(--sab)" }}>
            <div className="content-container pb-1 pt-3">
              <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5 shadow-sm">
                <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr] md:items-center">
                  <span className="hidden md:block" aria-hidden="true" />
                  <div role="toolbar" aria-label="演示回放控制" className="flex flex-wrap items-center justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={prev} disabled={stepIndex === 0} className="gap-1">
                      <ChevronLeft className="size-4" />
                      上一步
                    </Button>
                    <Button size="sm" onClick={next} disabled={atEnd || gateBlocked} className="gap-1">
                      {isStreaming ? "生成中" : gateBlocked ? "需先批准" : "下一步"}
                      <ChevronRight className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={reset} disabled={stepIndex === 0 && Object.keys(decisions).length === 0} className="gap-1">
                      <RotateCcw className="size-4" />
                      重放
                    </Button>
                  </div>
                  <div className="flex min-w-0 items-center justify-center gap-3 text-xs text-muted-foreground md:justify-end">
                    <span className="truncate">{caption}</span>
                    <span className="shrink-0 tabular-nums">{Math.min(stepIndex, total)} / {total}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {rightOpen && (
          <>
            <ResizablePanelDivider
              label="调整右侧看板宽度"
              onMouseDown={onDividerMouseDown}
              onDoubleClick={onDividerDoubleClick}
            />
            <div
              data-scenario-replay-panel
              className="flex min-h-0 shrink-0 flex-col border-l border-border"
              style={{ flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 0 }}
            >
              {/* 产物预览抢占面板：用户显式点击的意图压过自动跟随。
                  面板不卸载，只是被盖住，fold 状态与滚动位置都保留。 */}
              {artifactHtml ? (
                <ArtifactPanel
                  html={artifactHtml}
                  fileName={artifact!.fileName}
                  onClose={() => setArtifact(null)}
                  onBackToPanel={snapshot ? () => setArtifact(null) : undefined}
                />
              ) : null}
              <div className={cn("flex min-h-0 flex-1 flex-col", artifactHtml && "hidden")}>
                {snapshot ? <SystemPanel snapshot={snapshot} onSelectView={selectView} className="min-h-0 flex-1" /> : null}
              </div>
            </div>
          </>
        )}
      </div>

    </div>
  );
}

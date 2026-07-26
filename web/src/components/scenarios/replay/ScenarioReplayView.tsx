import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { mapSessionDetailToMessages, type ApiSessionDetail, type ApiTranscriptBlock } from "@agent/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/MessageList";
import { FilePreviewProvider } from "@/contexts/FilePreviewContext";
import { HTML_SANDBOX_CSP } from "@/components/HtmlPreviewPanel";
import { SystemPanel } from "@/components/SystemPanel";
import { useSystemPanel } from "@/hooks/useSystemPanel";
import { ActionIcons, EntityIcons, StatusIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { ReplayScript } from "./types";

const ApprovalIcon = EntityIcons.admin;
const ApprovalSuccessIcon = StatusIcons.success;
const UndoIcon = ActionIcons.undo;

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

export function ScenarioReplayView({ script, onExit }: { script: ReplayScript; onExit: () => void }) {
  // 打开即显示第一步，避免过去 0/N 的空白首屏。
  const [stepIndex, setStepIndex] = useState(1);
  const [decisions, setDecisions] = useState<Record<number, "approved" | "rejected">>({});
  const [artifact, setArtifact] = useState<{ path: string; fileName: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const total = script.steps.length;
  const atEnd = stepIndex >= total;
  const currentStepIndex = Math.max(0, stepIndex - 1);
  const currentStep = script.steps[currentStepIndex];
  const currentDecision = decisions[currentStepIndex];
  const gateBlocked = !!currentStep?.approval && currentDecision !== "approved";

  const messages = useMemo(() => {
    const blocks = script.steps.slice(0, stepIndex).flatMap((step, index) => [
      ...step.blocks,
      ...(decisions[index] === "approved" ? step.approval?.approvedBlocks ?? [] : []),
    ]);
    return blocks.length ? mapSessionDetailToMessages(buildDetail(blocks)) : [];
  }, [decisions, script, stepIndex]);

  // 面板从消息流 fold，与真实会话同一个 hook——面板没有独立数据通道
  const { snapshot, selectView } = useSystemPanel(messages);
  const artifactHtml = artifact ? script.artifacts?.[artifact.path] : undefined;
  const rightOpen = !!snapshot || !!artifactHtml;

  const next = useCallback(() => {
    if (gateBlocked) return;
    setStepIndex((i) => Math.min(total, i + 1));
  }, [gateBlocked, total]);
  const prev = useCallback(() => {
    setStepIndex((i) => Math.max(1, i - 1));
    setArtifact(null);
  }, []);
  const reset = useCallback(() => {
    setStepIndex(1);
    setDecisions({});
    setArtifact(null);
  }, []);

  const approveCurrentStep = useCallback(() => {
    if (!currentStep?.approval) return;
    setDecisions((current) => ({ ...current, [currentStepIndex]: "approved" }));
    setStepIndex((i) => Math.min(total, i + 1));
  }, [currentStep?.approval, currentStepIndex, total]);

  const rejectCurrentStep = useCallback(() => {
    if (!currentStep?.approval) return;
    setDecisions((current) => ({ ...current, [currentStepIndex]: "rejected" }));
  }, [currentStep?.approval, currentStepIndex]);

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

  // 推进后滚到底，模拟真实会话的跟随行为
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

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

      <div className="flex min-h-0 flex-1">
        <div className={cn("flex min-h-0 flex-col", rightOpen ? "w-1/2" : "w-full")}>
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
                        <Button type="button" variant="outline" size="sm" onClick={rejectCurrentStep}>
                          {currentStep.approval.rejectLabel ?? "退回修改"}
                        </Button>
                        <Button type="button" size="sm" className="gap-1" onClick={approveCurrentStep}>
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
        </div>

        {rightOpen && (
          <div className="flex min-h-0 w-1/2 flex-col border-l border-border">
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
        )}
      </div>

      {/* 回放条占据真实会话输入框的位置，它本身即演示状态的标识 */}
      <div className="flex shrink-0 items-center gap-3 border-t border-border bg-muted/40 px-4 py-3">
        <Button variant="outline" size="sm" onClick={prev} disabled={stepIndex === 1} className="gap-1">
          <ChevronLeft className="size-4" />
          上一步
        </Button>
        <Button size="sm" onClick={next} disabled={atEnd || gateBlocked} className="gap-1">
          {gateBlocked ? "需先批准" : "下一步"}
          <ChevronRight className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={reset} disabled={stepIndex === 1 && Object.keys(decisions).length === 0} className="gap-1">
          <RotateCcw className="size-4" />
          重放
        </Button>
        <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
          <span className="truncate">{caption}</span>
          <span className="tabular-nums">{Math.min(stepIndex, total)} / {total}</span>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { mapSessionDetailToMessages, type ApiSessionDetail, type ApiTranscriptBlock } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/MessageList";
import { FilePreviewProvider } from "@/contexts/FilePreviewContext";
import { HTML_SANDBOX_CSP } from "@/components/HtmlPreviewPanel";
import { SystemPanel } from "@/components/SystemPanel";
import { useSystemPanel } from "@/hooks/useSystemPanel";
import { cn } from "@/lib/utils";
import type { ReplayScript } from "./types";

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
  const [stepIndex, setStepIndex] = useState(0);
  const [artifact, setArtifact] = useState<{ path: string; fileName: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const total = script.steps.length;
  const atEnd = stepIndex >= total;

  const messages = useMemo(() => {
    const blocks = script.steps.slice(0, stepIndex).flatMap((step) => step.blocks);
    return blocks.length ? mapSessionDetailToMessages(buildDetail(blocks)) : [];
  }, [script, stepIndex]);

  // 面板从消息流 fold，与真实会话同一个 hook——面板没有独立数据通道
  const { snapshot, selectView } = useSystemPanel(messages);
  const artifactHtml = artifact ? script.artifacts?.[artifact.path] : undefined;
  const rightOpen = !!snapshot || !!artifactHtml;

  const next = useCallback(() => setStepIndex((i) => Math.min(total, i + 1)), [total]);
  const prev = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
    setArtifact(null);
  }, []);
  const reset = useCallback(() => {
    setStepIndex(0);
    setArtifact(null);
  }, []);

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

  const caption = atEnd ? "演示结束" : script.steps[stepIndex]?.caption ?? "";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onExit} className="gap-1 px-2">
          <ChevronLeft className="size-4" />
          返回
        </Button>
        <span className="min-w-0 truncate text-sm font-medium">{script.title}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn("flex min-h-0 flex-col", rightOpen ? "w-1/2" : "w-full")}>
          <FilePreviewProvider value={{ openPreview }}>
            <MessageList
              messages={messages}
              loading={false}
              isLoadingMessages={false}
              scrollContainerRef={scrollRef}
              debugModeOverride={false}
            />
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
        <Button variant="outline" size="sm" onClick={prev} disabled={stepIndex === 0} className="gap-1">
          <ChevronLeft className="size-4" />
          上一步
        </Button>
        <Button size="sm" onClick={next} disabled={atEnd} className="gap-1">
          下一步
          <ChevronRight className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={reset} disabled={stepIndex === 0} className="gap-1">
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

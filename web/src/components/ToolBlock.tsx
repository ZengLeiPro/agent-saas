import { useState, useMemo } from "react";
import { formatJson } from './types';
import { parseToolResult, getToolDisplayInfo } from '@agent/shared';
import { Wrench, CheckCircle2, ChevronRight, X, Loader2, CircleDashed, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { activityStatusBadgeClass, activityStatusIconClass, type ActivityStatusTone } from "./activityStatusStyles";

// ============================================
// Image Lightbox (shared)
// ============================================

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
        alt=""
      />
    </div>
  );
}

// ============================================
// Result Content (shared between ToolBlock and ToolResultBlock)
// ============================================

function ResultContent({ result, toolName, standalone }: { result: string; toolName: string; standalone?: boolean }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const parsed = useMemo(() => parseToolResult(result), [result]);
  const hasImages = parsed.images.length > 0;

  if (hasImages) {
    return (
      <>
        <div className="mt-1 flex flex-wrap gap-2">
          {parsed.images.map((img, i) => {
            const src = `data:${img.mimeType};base64,${img.data}`;
            return (
              <img
                key={i}
                src={src}
                className="max-h-80 max-w-full cursor-pointer rounded-lg border border-border shadow-sm transition-shadow hover:shadow-md"
                onClick={() => setLightboxSrc(src)}
                alt={`${toolName} result ${i + 1}`}
              />
            );
          })}
        </div>
        {parsed.text && (
          <pre className="mt-1 whitespace-pre-wrap break-words">{parsed.text}</pre>
        )}
        {lightboxSrc && (
          <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
        )}
      </>
    );
  }

  return <pre className={cn("whitespace-pre-wrap break-words", standalone && "code-preview mt-1")}>{result}</pre>;
}

// ============================================
// Unified ToolBlock (tool_use + result merged)
// ============================================

interface ToolBlockProps {
  toolName: string;
  toolInput: string;
  streaming?: boolean;
  result?: string;
  resultReady?: boolean;
  executionStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
  durationMs?: number;
  lastProgress?: string;
  error?: string;
}

function formatDuration(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function getExecutionLabel(status?: ToolBlockProps["executionStatus"], resultReady?: boolean): string {
  if (status === "running") return "执行中";
  if (status === "pending") return "待执行";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "completed" || resultReady) return "已完成";
  return "待执行";
}

function getExecutionTone(status?: ToolBlockProps["executionStatus"], resultReady?: boolean, streaming?: boolean): ActivityStatusTone {
  if (status === "running" || streaming) return "active";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "neutral";
  if (status === "completed" || resultReady) return "success";
  return "pending";
}

export function ToolBlock({ toolName, toolInput, streaming, result, resultReady, executionStatus, durationMs, lastProgress, error }: ToolBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const formatted = useMemo(() => formatJson(toolInput), [toolInput]);
  const displayInfo = useMemo(() => getToolDisplayInfo(toolName, toolInput), [toolName, toolInput]);
  const duration = formatDuration(durationMs);
  const statusLabel = getExecutionLabel(executionStatus, resultReady);
  const tone = getExecutionTone(executionStatus, resultReady, streaming);

  const icon = executionStatus === "running"
    ? <Loader2 className={activityStatusIconClass("active", "h-3.5 w-3.5 shrink-0 animate-spin")} />
    : executionStatus === "failed"
      ? <XCircle className={activityStatusIconClass("danger", "h-3.5 w-3.5 shrink-0")} />
      : executionStatus === "cancelled"
        ? <XCircle className={activityStatusIconClass("neutral", "h-3.5 w-3.5 shrink-0")} />
      : resultReady || executionStatus === "completed"
        ? <CheckCircle2 className={activityStatusIconClass("success", "h-3.5 w-3.5 shrink-0")} />
        : streaming
          ? <Wrench className={activityStatusIconClass("active", "h-3.5 w-3.5 shrink-0 animate-pulse")} />
          : <CircleDashed className={activityStatusIconClass("pending", "h-3.5 w-3.5 shrink-0")} />;

  return (
    <div className="my-0.5">
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {icon}
        <span className="flex min-w-0 max-w-sm items-baseline overflow-hidden whitespace-nowrap">
          <span className="shrink-0">{displayInfo.name}{displayInfo.detail ? ':' : ''}&nbsp;</span>
          {displayInfo.detail && (
            <span
              className="min-w-0 truncate"
              style={displayInfo.detailTruncate === 'start' ? { direction: 'rtl', textAlign: 'left' } : undefined}
            >
              {displayInfo.detail}
            </span>
          )}
          {(streaming || executionStatus === "running") && <span className="shrink-0 animate-pulse">...</span>}
        </span>
        <span className={activityStatusBadgeClass(tone)}>
          {duration && (executionStatus === "completed" || executionStatus === "failed" || executionStatus === "cancelled")
            ? `${statusLabel} ${duration}`
            : statusLabel}
        </span>
        <ChevronRight className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform",
          isExpanded && "rotate-90",
        )} />
      </button>
      {isExpanded && (
        <div>
          <div className="code-preview mt-1">
            <pre className="whitespace-pre-wrap break-words">{formatted}</pre>
            {resultReady && (
              <>
                <div className="my-2 border-t border-border pt-2 font-mono text-xs text-muted-foreground">Result:</div>
                <ResultContent result={result || ""} toolName={toolName} />
              </>
            )}
            {!resultReady && (lastProgress || error) && (
              <>
                <div className="my-2 border-t border-border pt-2 font-mono text-xs text-muted-foreground">
                  {error ? "Error:" : "Progress:"}
                </div>
                <pre className="whitespace-pre-wrap break-words">{error || lastProgress}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// Legacy ToolResultBlock (for old transcripts with standalone tool_result)
// ============================================

interface ToolResultBlockProps {
  toolName: string;
  result: string;
}

export function ToolResultBlock({ toolName, result }: ToolResultBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="my-0.5">
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">Result: {toolName}</span>
        <ChevronRight className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform",
          isExpanded && "rotate-90",
        )} />
      </button>
      {isExpanded && (
        <ResultContent result={result} toolName={toolName} standalone />
      )}
    </div>
  );
}

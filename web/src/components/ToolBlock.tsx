import { useState, useMemo } from "react";
import { formatJson } from './types';
import { parseToolResult, getToolDisplayInfo, toolResultExitCode, type ToolPresentation, type ToolResultMetadata } from '@agent/shared';
import { PresentationDetail } from './PresentationDetail';
import { Wrench, ChevronRight, CircleCheck } from "lucide-react";
import { StatusIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { activityStatusBadgeClass, activityStatusIconClass, formatActivityDuration, type ActivityStatusTone } from "./activityStatusStyles";
import { ImageLightbox } from "./ImageLightbox";

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
          <ImageLightbox src={lightboxSrc} alt={`${toolName} result`} onClose={() => setLightboxSrc(null)} />
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
  /** 「给人看」摘要。有值时展开态默认呈现它，原始 payload 退居 debug 视图。 */
  presentation?: ToolPresentation;
  /** 结构化执行事实（exitCode 等）。有退出码时 ✓/✗ 判定优先用它。 */
  toolMetadata?: ToolResultMetadata;
  /**
   * 是否呈现原始 payload。
   * 语义是「看不看得到原始数据」——无 presentation 时恒为真（否则展开将一片空白）。
   */
  debugMode?: boolean;
  /**
   * 首次挂载即展开摘要详情（来自 block.defaultOpen）。
   * 仅对带 presentation 的块生效——原始 payload 不因它上主流。
   */
  defaultExpanded?: boolean;
}

/**
 * 用结构化事实校正技术终态。
 *
 * 平台合成的 `executionStatus`（activityDurations.ts）来自 invocation status +
 * isError，是一条**转译过的**判定链；`metadata.exitCode` 是进程的原值。两者不
 * 一致时以原值为准——这正是本字段存在的理由。
 *
 * 只做单向校正（非零退出码 → 有异常），不反向把已判失败的降级成成功：
 * 退出码 0 并不等于这次调用成功（超时被杀、被中止、写产物失败都可能留下 0），
 * 拿 0 去覆盖一个 failed 等于用一个较弱的信号抹掉一个较强的信号。
 * 进行中/已取消同理不受退出码影响——它们描述的是生命周期而非结果。
 */
function resolveExecutionStatus(
  status: ToolBlockProps["executionStatus"],
  metadata?: ToolResultMetadata,
): ToolBlockProps["executionStatus"] {
  if (status === "pending" || status === "running" || status === "cancelled") return status;
  const exitCode = toolResultExitCode(metadata);
  if (exitCode !== undefined && exitCode !== 0) return "failed";
  return status;
}

function getExecutionLabel(status?: ToolBlockProps["executionStatus"], resultReady?: boolean): string {
  if (status === "running") return "执行中";
  if (status === "pending") return "待执行";
  if (status === "failed") return "有异常";
  if (status === "cancelled") return "已取消";
  if (status === "completed" || resultReady) return "已完成";
  return "待执行";
}

function getExecutionTone(status?: ToolBlockProps["executionStatus"], resultReady?: boolean, streaming?: boolean): ActivityStatusTone {
  if (status === "running" || streaming) return "active";
  if (status === "failed") return "warning";
  if (status === "cancelled") return "neutral";
  if (status === "completed" || resultReady) return "success";
  return "pending";
}

export function ToolBlock({ toolName, toolInput, streaming, result, resultReady, executionStatus: rawExecutionStatus, durationMs, lastProgress, error, presentation, toolMetadata, debugMode = true, defaultExpanded = false }: ToolBlockProps) {
  // 折叠行已展示业务摘要标题，详情由用户按需展开，避免工具调用密集时刷屏；
  // 剧本标记 defaultOpen 的高价值执行块（且带摘要）首次挂载即展开。
  const [isExpanded, setIsExpanded] = useState(defaultExpanded && !!presentation);
  const showRaw = debugMode || !presentation;

  const executionStatus = resolveExecutionStatus(rawExecutionStatus, toolMetadata);
  const formatted = useMemo(() => formatJson(toolInput), [toolInput]);
  const displayInfo = useMemo(() => getToolDisplayInfo(toolName, toolInput), [toolName, toolInput]);
  const duration = formatActivityDuration(durationMs);
  const statusLabel = getExecutionLabel(executionStatus, resultReady);
  const tone = getExecutionTone(executionStatus, resultReady, streaming);

  const icon = executionStatus === "running"
    ? <StatusIcons.running className={activityStatusIconClass("active", "size-3.5 shrink-0 animate-spin")} />
    : executionStatus === "failed"
      ? <StatusIcons.error className={activityStatusIconClass("warning", "size-3.5 shrink-0")} />
      : executionStatus === "cancelled"
        ? <StatusIcons.cancelled className={activityStatusIconClass("neutral", "size-3.5 shrink-0")} />
      : resultReady || executionStatus === "completed"
        ? <StatusIcons.success className={activityStatusIconClass("success", "size-3.5 shrink-0")} />
        : streaming
          ? <Wrench className={activityStatusIconClass("active", "size-3.5 shrink-0 animate-pulse")} />
          : <StatusIcons.pending className={activityStatusIconClass("pending", "size-3.5 shrink-0")} />;

  return (
    <div>
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {icon}
        <span className="flex min-w-0 max-w-sm items-baseline overflow-hidden whitespace-nowrap">
          {presentation ? (
            // 摘要标题是业务语言，视觉权重高于机械拼出的 "工具名: 入参"
            <span className="min-w-0 truncate text-foreground">
              {presentation.connector ? `连接器 · ${presentation.title}` : presentation.title}
            </span>
          ) : (
            <>
              <span className="shrink-0">{displayInfo.name}{displayInfo.detail ? ':' : ''}&nbsp;</span>
              {displayInfo.detail && (
                <span
                  className="min-w-0 truncate"
                  style={displayInfo.detailTruncate === 'start' ? { direction: 'rtl', textAlign: 'left' } : undefined}
                >
                  {displayInfo.detail}
                </span>
              )}
            </>
          )}
          {(streaming || executionStatus === "running") && <span className="shrink-0 animate-pulse">...</span>}
        </span>
        <span className={activityStatusBadgeClass(tone)}>
          {duration && (executionStatus === "completed" || executionStatus === "failed" || executionStatus === "cancelled")
            ? `${statusLabel} ${duration}`
            : statusLabel}
        </span>
        {presentation?.receipt && (
          // 外部系统写回执是「AI 在动系统」的关键痕迹，折叠态也要可见
          <span className={activityStatusBadgeClass(presentation.receipt.readBack ? "success" : "neutral", "inline-flex max-w-40 items-center gap-1")}>
            <span className="truncate">→ {presentation.receipt.system}</span>
            {presentation.receipt.readBack && <CircleCheck className="size-3 shrink-0" />}
          </span>
        )}
        <ChevronRight className={cn(
          "size-3.5 shrink-0 transition-transform",
          isExpanded && "rotate-90",
        )} />
      </button>
      {isExpanded && (
        <div>
          {presentation && (
            // 折叠行的状态徽章已表达技术终态（有异常/已取消），
            // 摘要里不再重复一遍业务状态，避免同一条信息说两遍且措辞不一致
            <PresentationDetail
              data={presentation}
              hideStatus={executionStatus === 'failed' || executionStatus === 'cancelled'}
            />
          )}
          {showRaw && (
          <div className="code-preview mt-1">
            <pre className="whitespace-pre-wrap break-words">{formatted}</pre>
            {resultReady && (
              <>
                <div className={cn("my-2 border-t border-border pt-2 font-mono text-xs", executionStatus === "failed" ? "text-destructive" : "text-muted-foreground")}>
                  {executionStatus === "failed" ? "Error:" : "Result:"}
                </div>
                <div className={cn(executionStatus === "failed" && "text-destructive")}>
                  <ResultContent result={executionStatus === "failed" ? error || result || "" : result || ""} toolName={toolName} />
                </div>
              </>
            )}
            {!resultReady && (lastProgress || error) && (
              <>
                <div className="my-2 border-t border-border pt-2 font-mono text-xs text-muted-foreground">
                  {error ? "Error:" : "Progress:"}
                </div>
                <pre className={cn("whitespace-pre-wrap break-words", error && "text-destructive")}>{error || lastProgress}</pre>
              </>
            )}
          </div>
          )}
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
  presentation?: ToolPresentation;
  debugMode?: boolean;
}

export function ToolResultBlock({ toolName, result, presentation, debugMode = true }: ToolResultBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const showRaw = debugMode || !presentation;

  return (
    <div>
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <StatusIcons.success className={activityStatusIconClass("success", "size-3.5 shrink-0")} />
        <span className={cn("min-w-0 truncate", presentation && "text-foreground")}>
          {presentation
            ? presentation.connector
              ? `连接器 · ${presentation.title}`
              : presentation.title
            : `Result: ${toolName}`}
        </span>
        <ChevronRight className={cn(
          "size-3.5 shrink-0 transition-transform",
          isExpanded && "rotate-90",
        )} />
      </button>
      {isExpanded && (
        <>
          {presentation && <PresentationDetail data={presentation} />}
          {showRaw && <ResultContent result={result} toolName={toolName} standalone />}
        </>
      )}
    </div>
  );
}

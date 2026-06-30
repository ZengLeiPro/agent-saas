import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo, lazy, Suspense } from 'react';
import { Copy, Check, Volume2, VolumeX, Loader2, Pause, Play, FileText, FileCode, FileImage, FileVideo, FileSpreadsheet, FileArchive, Presentation, File, Download, X, GitFork, Paperclip, ImageIcon, Mic } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { MessageItem as MessageItemType, formatFileSize } from './types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolBlock, ToolResultBlock } from './ToolBlock';
import { PermissionBlock } from './PermissionBlock';
import { AskUserBlock } from './AskUserBlock';
import { SubagentBlock } from './SubagentBlock';
import { ExecutionHiddenPlaceholder } from './ActivityGroupBlock';
import { UserVoiceMessage } from './UserVoiceMessage';
import { cn } from '@/lib/utils';
import { VoiceBar } from './VoiceBar';
import { useFilePreview } from '@/contexts/FilePreviewContext';
import { authFetch } from '@/lib/authFetch';
import { extractTextFromChildren, getCellMinWidthPx } from '@/lib/tableCellWidth';
import { MD_PATH_RE, HTML_PATH_RE, resolveImageSrc, getPreviewFileType, getFileTypeVisual } from '@agent/shared';
import type { FileTypeCategory } from '@agent/shared';
import type { TtsState } from '@/hooks/useTtsPlayer';
import type { UseVoicePlayerReturn } from '@/hooks/useVoicePlayer';
import type { Components } from 'react-markdown';

// react-markdown 懒加载：不阻塞首屏渲染，模块加载后立即可用
const markdownPromise = import("react-markdown");
const remarkGfmPromise = import("remark-gfm");
const remarkMathPromise = import("remark-math");
const rehypeKatexPromise = import("rehype-katex");
import "katex/dist/katex.min.css";

/** 判断是否为外部 URL 或 data URI */
function isExternalSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v|avi)$/i;

/** 工作区图片：异步解析路径，支持 lightbox 大图 */
function AuthImage({ src, alt, owner }: { src: string; alt?: string; owner?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveImageSrc(src, owner)
      .then(url => { if (!cancelled) setResolvedSrc(url); })
      .catch(() => { if (!cancelled) setResolvedSrc(src); });
    return () => { cancelled = true; };
  }, [src, owner]);

  if (!resolvedSrc) {
    return <span className="inline-block h-40 w-60 animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <>
      <img
        src={resolvedSrc}
        alt={alt}
        className="max-h-80 max-w-full cursor-pointer rounded-lg border border-border shadow-sm transition-shadow hover:shadow-md"
        onClick={() => setLightbox(true)}
      />
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(false)}
        >
          <button
            onClick={() => setLightbox(false)}
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={resolvedSrc}
            alt={alt}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

/** 工作区视频：异步解析路径，HTML5 video 播放 */
function AuthVideo({ src, owner }: { src: string; owner?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveImageSrc(src, owner)
      .then(url => { if (!cancelled) setResolvedSrc(url); })
      .catch(() => { if (!cancelled) setResolvedSrc(src); });
    return () => { cancelled = true; };
  }, [src, owner]);

  if (!resolvedSrc) {
    return <span className="inline-block h-40 w-60 animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <video
      src={resolvedSrc}
      controls
      playsInline
      preload="metadata"
      className="max-h-80 max-w-full rounded-lg border border-border shadow-sm"
    />
  );
}

const LazyMarkdown = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remarkMath }, { default: rehypeKatex }] = await Promise.all([
    markdownPromise,
    remarkGfmPromise,
    remarkMathPromise,
    rehypeKatexPromise,
  ]);
  function MarkdownWithPreview({ content }: { content: string }) {
    const filePreview = useFilePreview();

    const mdComponents = useMemo<Components>(() => ({
      a: ({ node, children, href, ...props }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
      ),
      table: ({ node, children, ...props }) => (
        <div className="overflow-x-auto">
          <table {...props}>{children}</table>
        </div>
      ),
      // td/th 注入 min-width = ⌈文本宽度 / 4⌉，保证自然换行不超过 4 行
      td: ({ node, children, style, ...props }) => (
        <td style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }} {...props}>{children}</td>
      ),
      th: ({ node, children, style, ...props }) => (
        <th style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }} {...props}>{children}</th>
      ),
      code: ({ node, className, children, ...props }) => {
        // 有 className 说明是代码块（```lang），跳过
        if (className) {
          return <code className={className} {...props}>{children}</code>;
        }
        const text = String(children).replace(/\n$/, '');
        if (filePreview && (MD_PATH_RE.test(text) || HTML_PATH_RE.test(text))) {
          return (
            <code
              className="cursor-pointer underline decoration-dotted underline-offset-2"
              onClick={() => filePreview.openPreview(text, filePreview.owner)}
              {...props}
            >
              {children}
            </code>
          );
        }
        return <code {...props}>{children}</code>;
      },
      pre: ({ node, children, ...props }) => {
        let text = '';
        React.Children.forEach(children, (child) => {
          if (React.isValidElement(child)) {
            text = String((child.props as { children?: unknown }).children ?? '').replace(/\n$/, '');
          }
        });
        return (
          <div className="group/code relative">
            <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover/code:opacity-100">
              <CopyButton text={text} />
            </div>
            <pre {...props}>{children}</pre>
          </div>
        );
      },
      img: ({ src, alt, ...props }) => {
        if (!src || isExternalSrc(src)) {
          if (src && VIDEO_EXT_RE.test(src)) {
            return <video src={src} controls playsInline preload="metadata" className="max-h-80 max-w-full rounded-lg border border-border shadow-sm" />;
          }
          return <img src={src} alt={alt} {...props} />;
        }
        if (VIDEO_EXT_RE.test(src)) {
          return <AuthVideo src={src} owner={filePreview?.owner} />;
        }
        return <AuthImage src={src} alt={alt ?? ''} owner={filePreview?.owner} />;
      },
    }), [filePreview]);

    return (
      <Markdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[rehypeKatex]} components={mdComponents}>
        {content}
      </Markdown>
    );
  }
  return { default: MarkdownWithPreview };
});

/** 还原 markdown 中被反斜杠转义的常见语法字符 */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([*_~`#\-\[\]()>|])/g, '$1');
}

/** 剥离 [VOICE]...[/VOICE] 标记，避免在消息气泡中显示原始标记文本 */
function stripVoiceMarkers(text: string): string {
  return text.replace(/\[VOICE(?:\s+[^\]]*)?\][\s\S]*?\[\/VOICE\]/g, '').trim();
}

/** 剥离 [VIDEO/AUDIO]...[/...] 标记（FILE 标签由 splitByFileMarkers 处理） */
function stripNonFileMediaMarkers(text: string): string {
  return text.replace(/\[(?:VIDEO|AUDIO)\]\{.*?\}\[\/(?:VIDEO|AUDIO)\]/g, '').trim();
}

const FILE_MARKER_RE = /\[FILE\](\{.*?\})\[\/FILE\]/g;

type TextSegment = { type: 'text'; content: string } | { type: 'file'; filePath: string; fileName: string };

/** Split text content by [FILE] markers, returning interleaved text and file segments */
function splitByFileMarkers(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(FILE_MARKER_RE)) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: 'text', content: before });
    try {
      const json = JSON.parse(match[1]);
      const filePath = json.filePath || '';
      const fileName = filePath.split('/').pop() || filePath;
      segments.push({ type: 'file', filePath, fileName });
    } catch { /* malformed JSON — skip */ }
    lastIndex = match.index! + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim()) segments.push({ type: 'text', content: tail });
  return segments;
}

/** 触发文件下载：构造带 ?token= 的 URL，交给浏览器原生流式下载（避免大文件被 fetch 整入内存） */
async function authFetchDownload(filePath: string, fileName: string, owner?: string) {
  try {
    const url = await resolveImageSrc(filePath, owner);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.error('File download failed:', err);
  }
}

/** 文件下载卡片，fileSize 为 0 时通过 HEAD 请求懒加载真实大小 */
/** 文件分类 → lucide 图标 */
const CATEGORY_ICON: Record<FileTypeCategory, LucideIcon> = {
  pdf: FileText, word: FileText, ppt: Presentation,
  excel: FileSpreadsheet, code: FileCode, image: FileImage,
  video: FileVideo, text: FileText, archive: FileArchive, default: File,
};

function FileDownloadCard({ fileName, filePath, fileSize, filePreview, owner }: {
  fileName: string;
  filePath: string;
  fileSize: number;
  filePreview: ReturnType<typeof useFilePreview> | null;
  owner?: string;
}) {
  const [resolvedSize, setResolvedSize] = useState(fileSize);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const ownerParam = owner ? `&owner=${encodeURIComponent(owner)}` : '';

  useEffect(() => {
    if (fileSize > 0) return;
    let cancelled = false;
    authFetch(`/api/file/download?path=${encodeURIComponent(filePath)}${ownerParam}`, { method: 'HEAD' })
      .then(res => {
        if (cancelled) return;
        const cl = res.headers.get('content-length');
        if (cl) setResolvedSize(Number(cl));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath, fileSize, ownerParam]);

  const isPreviewable = !!getPreviewFileType(fileName);
  const visual = getFileTypeVisual(fileName);
  const TypeIcon = CATEGORY_ICON[visual.category];
  const isImage = visual.category === 'image';
  const canOpenPreview = isImage || (isPreviewable && !!filePreview);

  const handleClick = () => {
    if (isImage) {
      void resolveImageSrc(filePath, owner)
        .then(setPreviewSrc)
        .catch(() => setPreviewSrc(filePath));
    } else if (isPreviewable && filePreview) {
      filePreview.openPreview(filePath, owner);
    }
  };

  return (
    <>
      <div className="flex justify-start">
        <div
          className={cn(
            "flex items-center gap-3 rounded-xl bg-muted px-4 py-3 transition-colors",
            canOpenPreview && "cursor-pointer hover:bg-border",
          )}
          onClick={canOpenPreview ? handleClick : undefined}
        >
          <div className="flex items-center justify-center rounded-lg w-10 h-10 shrink-0" style={{ backgroundColor: visual.color }}>
            <TypeIcon className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{fileName}</div>
            {resolvedSize > 0 && <div className="text-xs text-muted-foreground">{formatFileSize(resolvedSize)}</div>}
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); authFetchDownload(filePath, fileName, owner); }}
            title="下载"
            aria-label={`下载 ${fileName}`}
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>
      {previewSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewSrc(null)}
        >
          <button
            type="button"
            onClick={() => setPreviewSrc(null)}
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            title="关闭"
            aria-label="关闭预览"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={previewSrc}
            alt={fileName}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
      title="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function TtsButton({
  state,
  onPlay,
  onTogglePause,
}: {
  state: TtsState;
  onPlay: () => void;
  onTogglePause: () => void;
}) {
  const iconClass = 'h-3.5 w-3.5';

  const handleClick = () => {
    if (state === 'idle' || state === 'error') {
      onPlay();
    } else if (state === 'playing' || state === 'paused') {
      onTogglePause();
    }
  };

  let icon;
  let colorClass = 'text-muted-foreground/50 hover:text-muted-foreground';
  let title = 'Read aloud';

  switch (state) {
    case 'loading':
      icon = <Loader2 className={cn(iconClass, 'animate-spin')} />;
      colorClass = 'text-primary';
      title = 'Generating audio...';
      break;
    case 'playing':
      icon = <Pause className={iconClass} />;
      colorClass = 'text-primary';
      title = 'Pause';
      break;
    case 'paused':
      icon = <Play className={iconClass} />;
      colorClass = 'text-primary';
      title = 'Resume';
      break;
    case 'error':
      icon = <VolumeX className={iconClass} />;
      colorClass = 'text-destructive/70';
      title = 'Error';
      break;
    default:
      icon = <Volume2 className={iconClass} />;
  }

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      className={cn('rounded-md p-1 transition-colors', colorClass)}
      title={title}
    >
      {icon}
    </button>
  );
}

/** 操作按钮组：TTS + 复制 */
function ActionButtons({
  text,
  ttsState,
  showTts,
  onTtsPlay,
  onTtsTogglePause,
}: {
  text: string;
  ttsState: TtsState;
  showTts: boolean;
  onTtsPlay: () => void;
  onTtsTogglePause: () => void;
}) {
  return (
    <>
      {showTts && (
        <TtsButton state={ttsState} onPlay={onTtsPlay} onTogglePause={onTtsTogglePause} />
      )}
      <CopyButton text={text} />
    </>
  );
}


export interface TtsProps {
  getState: (key: string) => TtsState;
  activeKey: string | null;
  play: (key: string, text: string) => void;
  togglePause: (key: string) => void;
  available: boolean;
}

interface MessageItemProps {
  message: MessageItemType;
  index: number;
  onPermissionResponse?: (interactionId: string, allow: boolean) => void;
  onAskUserResponse?: (interactionId: string, answers: Record<string, string>) => void;
  onRetry?: (message: MessageItemType) => void;
  onFork?: (message: MessageItemType) => void;
  /** 是否为第一条用户消息（不显示 fork） */
  isFirstUser?: boolean;
  /** AI 是否正在回复（不显示 fork） */
  isLoading?: boolean;
  tts?: TtsProps;
  ttsState?: TtsState;
  ttsIsActive?: boolean;
  /** 用户语音消息回放控制 */
  voicePlayer?: UseVoicePlayerReturn;
  /** user-voice 消息的播放状态（从外部注入以支持 memo） */
  voicePlayState?: import('@/hooks/useVoicePlayer').VoicePlayState;
  /** 是否显示思考、工具、Skill/子任务等执行细节。 */
  debugMode?: boolean;
}

export const MessageItem = memo(function MessageItem({
  message,
  index,
  onPermissionResponse,
  onAskUserResponse,
  onRetry,
  onFork,
  isFirstUser,
  isLoading,
  tts,
  ttsState: ttsStateProp,
  ttsIsActive: ttsIsActiveProp,
  voicePlayer,
  voicePlayState,
  debugMode = true,
}: MessageItemProps) {
  const filePreview = useFilePreview();
  const msgKey = `msg-${index}`;

  // Inline footer: 测量最后一行文字宽度，决定 footer 放在同一行还是下一行
  const showTextFooter = message.type === 'text' && !message.streaming;
  const textContentRef = useRef<HTMLDivElement>(null);
  const textFooterRef = useRef<HTMLDivElement>(null);
  const [footerInline, setFooterInline] = useState(false);
  const [footerBottomPx, setFooterBottomPx] = useState(0);

  useLayoutEffect(() => {
    const contentEl = textContentRef.current;
    const footerEl = textFooterRef.current;
    if (!showTextFooter || !contentEl || !footerEl) {
      setFooterInline(false);
      return;
    }

    const measure = () => {
      const containerRect = contentEl.getBoundingClientRect();
      const footerWidth = footerEl.offsetWidth;
      const gap = 12;

      // 遍历所有文本节点，找到最后一个非空文本节点
      const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
      let lastText: Text | null = null;
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if ((n as Text).textContent?.trim()) lastText = n as Text;
      }

      if (!lastText) { setFooterInline(false); return; }

      const range = document.createRange();
      range.selectNodeContents(lastText);
      const rects = range.getClientRects();
      if (rects.length === 0) { setFooterInline(false); return; }

      const lastRect = rects[rects.length - 1];
      const lastLineEndX = lastRect.right - containerRect.left;
      const available = containerRect.width - lastLineEndX;

      if (available >= footerWidth + gap) {
        setFooterInline(true);
        setFooterBottomPx(containerRect.bottom - lastRect.bottom);
      } else {
        setFooterInline(false);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [showTextFooter]);

  const ttsState = ttsStateProp ?? tts?.getState(msgKey) ?? 'idle';
  const isPlaying = (ttsIsActiveProp ?? tts?.activeKey === msgKey) && ttsState === 'playing';
  const showTts = !!tts?.available
    && (message.type === 'text' || message.type === 'user')
    && !('streaming' in message && message.streaming)
    && message.content.trim().length > 0;

  if (message.type === "user") {
    const isFailed = message.status === 'failed';
    return (
      <div className="flex flex-col items-end">
        <div className="group max-w-full">
          <div
            className={cn(
              "whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-user-bubble px-3.5 py-2 msg-user-text text-foreground ring-1 ring-[rgba(232,132,58,0.22)] shadow-[0_1px_2px_rgba(232,132,58,0.10),0_4px_12px_-4px_rgba(232,132,58,0.20)]",
              isPlaying && "border-l-2 border-primary",
              isFailed && "opacity-60",
            )}
          >
            {message.isVoiceTranscript && (
              <span className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Mic className="h-3 w-3" />
                <span>语音转文字</span>
              </span>
            )}
            {(message.displayContent ?? message.content) || null}
            {message.attachments && message.attachments.length > 0 && (
              <div className={cn("flex flex-wrap gap-1", (message.displayContent ?? message.content) && "mt-1.5")}>
                {message.attachments.map((att, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {att.isImage
                      ? <ImageIcon className="h-3 w-3 shrink-0" />
                      : <Paperclip className="h-3 w-3 shrink-0" />
                    }
                    <span className="max-w-[200px] truncate">{att.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          {/* 失败态副文案 + 重试按钮 */}
          {isFailed && (
            <div className="mt-1 flex items-center justify-end gap-2 text-xs">
              <span className="text-destructive">
                {message.failedReason || '发送失败'}
              </span>
              {onRetry && (
                <button
                  onClick={() => onRetry(message)}
                  className="rounded-md bg-foreground/[0.06] px-2 py-0.5 text-foreground/70 transition-colors hover:bg-foreground/[0.1] hover:text-foreground"
                >
                  重试
                </button>
              )}
            </div>
          )}
          <div className="relative h-0">
            <div className={cn(
              "absolute right-0 top-0.5 flex items-center gap-0.5 transition-opacity",
              "opacity-100 md:opacity-0 md:group-hover:opacity-100",
            )}>
              {onFork && !isFirstUser && !isLoading && !isFailed && message.id.startsWith('line-') && (
                <button
                  onClick={() => onFork(message)}
                  className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  title="从此编辑"
                >
                  <GitFork className="h-3.5 w-3.5" />
                </button>
              )}
              {!isFailed && (
                <ActionButtons
                  text={message.content}
                  ttsState={ttsState}
                  showTts={showTts}
                  onTtsPlay={() => tts?.play(msgKey, message.content)}
                  onTtsTogglePause={() => tts?.togglePause(msgKey)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (message.type === "text") {
    const voiceStripped = stripVoiceMarkers(message.content);
    const segments = splitByFileMarkers(voiceStripped);
    // Fallback: if no FILE markers, treat entire content as single text segment
    const hasFileSegments = segments.some(s => s.type === 'file');
    const cleanContent = hasFileSegments ? '' : stripNonFileMediaMarkers(voiceStripped);
    const showFooter = showTextFooter;
    return (
      <div className="flex justify-start">
        <div className="group relative w-full min-w-0">
          <div
            ref={textContentRef}
            className={cn(
              "overflow-hidden break-words text-foreground prose-chat",
              isPlaying && "border-l-2 border-primary pl-2",
            )}
          >
            {hasFileSegments ? (
              segments.map((seg, si) =>
                seg.type === 'file' ? (
                  <div key={`file-${si}`} className="my-2 not-prose">
                    <FileDownloadCard
                      fileName={seg.fileName}
                      filePath={seg.filePath}
                      fileSize={0}
                      filePreview={filePreview}
                      owner={message.owner}
                    />
                  </div>
                ) : (
                  <Suspense key={`text-${si}`} fallback={<div className="whitespace-pre-wrap break-words">{seg.content}</div>}>
                    <LazyMarkdown content={unescapeMarkdown(stripNonFileMediaMarkers(seg.content))} />
                  </Suspense>
                ),
              )
            ) : (
              <Suspense fallback={<div className="whitespace-pre-wrap break-words">{cleanContent}</div>}>
                <LazyMarkdown content={unescapeMarkdown(cleanContent)} />
              </Suspense>
            )}
            {message.voiceMarkers?.map((marker, vi) => {
              const voiceKey = `voice-${index}-${vi}`;
              const voiceState = tts?.getState(voiceKey) ?? 'idle';
              return (
                <VoiceBar
                  key={vi}
                  text={marker.text}
                  voice={marker.voice}
                  speed={marker.speed}
                  state={voiceState}
                  onPlay={() => tts?.play(voiceKey, marker.text)}
                  onTogglePause={() => tts?.togglePause(voiceKey)}
                />
              );
            })}
          </div>
          {showFooter && (
            <div
              ref={textFooterRef}
              className="absolute right-0 flex w-fit items-center gap-1"
              style={footerInline ? { bottom: footerBottomPx } : { bottom: -2 }}
            >
              <div className={cn(
                "flex items-center gap-0.5 transition-opacity",
                "opacity-100 md:opacity-0 md:group-hover:opacity-100",
              )}>
                <ActionButtons
                  text={cleanContent}
                  ttsState={ttsState}
                  showTts={showTts}
                  onTtsPlay={() => tts?.play(msgKey, cleanContent)}
                  onTtsTogglePause={() => tts?.togglePause(msgKey)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.type === "voice") {
    return (
      <div className="flex justify-start">
        <div className="w-full max-w-sm">
          {message.voiceMarkers.map((marker, vi) => {
            const voiceKey = `voice-${index}-${vi}`;
            const voiceState = tts?.getState(voiceKey) ?? 'idle';
            return (
              <VoiceBar
                key={vi}
                text={marker.text}
                voice={marker.voice}
                speed={marker.speed}
                state={voiceState}
                onPlay={() => tts?.play(voiceKey, marker.text)}
                onTogglePause={() => tts?.togglePause(voiceKey)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  if (message.type === "file_download") {
    return (
      <FileDownloadCard
        fileName={message.fileName}
        filePath={message.filePath}
        fileSize={message.fileSize}
        filePreview={filePreview}
        owner={message.owner}
      />
    );
  }

  if (message.type === "thinking") {
    if (!debugMode) return <ExecutionHiddenPlaceholder isActive={message.streaming} />;
    return (
      <ThinkingBlock
        content={message.content}
        streaming={message.streaming}
      />
    );
  }

  if (message.type === "tool_use") {
    if (!debugMode) return <ExecutionHiddenPlaceholder isActive={message.streaming || !message.resultReady} />;
    return (
      <ToolBlock
        toolName={message.toolName}
        toolInput={message.toolInput}
        streaming={message.streaming}
        result={message.result}
        resultReady={message.resultReady}
      />
    );
  }

  if (message.type === "tool_result") {
    if (!debugMode) return <ExecutionHiddenPlaceholder />;
    return (
      <ToolResultBlock
        toolName={message.toolName}
        result={message.result}
      />
    );
  }

  if (message.type === "permission_request") {
    return (
      <PermissionBlock
        toolName={message.toolName}
        toolInput={message.toolInput}
        status={message.status}
        onAllow={() => onPermissionResponse?.(message.interactionId, true)}
        onDeny={() => onPermissionResponse?.(message.interactionId, false)}
      />
    );
  }

  if (message.type === "ask_user") {
    return (
      <AskUserBlock
        questions={message.questions}
        status={message.status}
        answers={message.answers}
        onSubmit={(answers) => onAskUserResponse?.(message.interactionId, answers)}
      />
    );
  }

  if (message.type === "subagent") {
    if (!debugMode) return <ExecutionHiddenPlaceholder isActive={message.status === "running"} />;
    return (
      <SubagentBlock
        agentType={message.agentType}
        status={message.status}
      />
    );
  }

  if (message.type === "user-voice") {
    const voiceId = `voice-msg-${message.id}`;
    return (
      <UserVoiceMessage
        audioUrl={message.audioUrl}
        duration={message.duration}
        transcribedText={message.transcribedText}
        status={message.status}
        playState={voicePlayState ?? 'idle'}
        onPlay={() => voicePlayer?.play(voiceId, message.audioUrl)}
        onTogglePause={() => voicePlayer?.togglePause(voiceId)}
        timestamp={message.timestamp}
      />
    );
  }

  if (message.type === "system-error") {
    // 会话级失败/取消提示。明显区别于 AI 文本：左侧色边 + 图标 + 不同底色。
    // severity='cancelled' 用灰色（中性、用户主动），其余 'error' 用红色。
    const isCancelled = message.severity === 'cancelled';
    const containerCls = isCancelled
      ? 'border-l-4 border-zinc-400 bg-zinc-50 text-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-300 dark:border-zinc-500'
      : 'border-l-4 border-red-500 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200 dark:border-red-600';
    return (
      <div className={`px-3 py-2 rounded-r text-sm ${containerCls}`} role="alert">
        <div className="flex items-start gap-2">
          <span aria-hidden="true" className="mt-0.5 text-base leading-none">
            {isCancelled ? '⊘' : '⚠'}
          </span>
          <div className="flex-1 whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  return null;
}, (prev, next) => (
  prev.message === next.message &&
  prev.index === next.index &&
  prev.onPermissionResponse === next.onPermissionResponse &&
  prev.onAskUserResponse === next.onAskUserResponse &&
  prev.onRetry === next.onRetry &&
  prev.onFork === next.onFork &&
  prev.isFirstUser === next.isFirstUser &&
  prev.isLoading === next.isLoading &&
  prev.ttsState === next.ttsState &&
  prev.ttsIsActive === next.ttsIsActive &&
  prev.voicePlayState === next.voicePlayState &&
  prev.debugMode === next.debugMode
));

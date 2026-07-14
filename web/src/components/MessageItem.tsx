import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo, lazy, Suspense } from 'react';
import { Copy, Check, Volume2, VolumeX, Loader2, Pause, Play, Download, X, GitFork, Paperclip, ImageIcon, Mic, Ban, TriangleAlert } from 'lucide-react';
import { CATEGORY_ICON } from '@/lib/fileCategoryIcons';
import { MessageItem as MessageItemType, formatFileSize } from './types';
import type { AskUserAnswers } from '@agent/shared';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolBlock, ToolResultBlock } from './ToolBlock';
import { PermissionBlock } from './PermissionBlock';
import { AskUserBlock } from './AskUserBlock';
import { SubagentBlock } from './SubagentBlock';
import { ExecutionHiddenPlaceholder } from './ActivityGroupBlock';
import { RuntimeStatusBlock } from './RuntimeStatusBlock';
import { UserVoiceMessage } from './UserVoiceMessage';
import { cn } from '@/lib/utils';
import { VoiceBar } from './VoiceBar';
import { useFilePreview } from '@/contexts/FilePreviewContext';
import { authFetch } from '@/lib/authFetch';
import { extractTextFromChildren, getCellMinWidthPx } from '@/lib/tableCellWidth';
import { MD_PATH_RE, HTML_PATH_RE, resolveImageSrc, getPreviewFileType, getFileTypeVisual, splitByMessageMarkers, stripPartialCiteMarker } from '@agent/shared';
import { CitationCard } from './CitationCard';
import { MessageFeedbackButton } from './MessageFeedback';
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

// [FILE]/[CITE] 标记切分已泛化到 shared splitByMessageMarkers（FILE 行为逐行为等价，
// 兼容性红线有 markers.test.ts 回归锁）；CITE 段渲染为 CitationCard。

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

function shareFileUrl(shareToken: string, filePath: string): string {
  return `/api/share/sessions/${encodeURIComponent(shareToken)}/file?path=${encodeURIComponent(filePath)}`;
}

async function shareFileDownload(shareToken: string, filePath: string, fileName: string) {
  const a = document.createElement('a');
  a.href = shareFileUrl(shareToken, filePath);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Artifact 签名 URL 解析：调 /api/artifacts/:id/read-url,后端返回 15 min TTL
 * 的直读 URL（本地 blob=签名 token,OSS=预签名 URL）。失败时抛错让调用侧兜底。
 */
async function resolveArtifactUrl(artifactId: string): Promise<string> {
  const res = await authFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/read-url`);
  if (!res.ok) throw new Error(`resolveArtifactUrl: ${res.status}`);
  const body = await res.json() as { url?: string };
  if (!body.url) throw new Error('resolveArtifactUrl: missing url');
  return body.url;
}

/** Artifact 交付卡片下载：用签名 URL 触发浏览器原生下载。 */
async function artifactDownload(artifactId: string, fileName: string) {
  try {
    const url = await resolveArtifactUrl(artifactId);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.error('Artifact download failed:', err);
  }
}

/** 文件下载卡片，fileSize 为 0 时通过 HEAD 请求懒加载真实大小 */
function FileDownloadCard({ fileName, filePath, fileSize, filePreview, owner, artifactId, shareToken }: {
  fileName: string;
  filePath: string;
  fileSize: number;
  filePreview: ReturnType<typeof useFilePreview> | null;
  owner?: string;
  /** legacy artifact_created 事件：优先走 artifact 签名 URL,不依赖 workspace 文件仍在原位。 */
  artifactId?: string;
  /** 只读分享页使用 share token 读取快照关联文件，不依赖登录态。 */
  shareToken?: string;
}) {
  const [resolvedSize, setResolvedSize] = useState(fileSize);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const ownerParam = owner ? `&owner=${encodeURIComponent(owner)}` : '';

  useEffect(() => {
    if (fileSize > 0) return;
    // artifact 卡片：大小已由 tool result 带出（sizeBytes 常存在但可能为 0）
    // 这时不 fallback HEAD /api/file/download——sourcePath 可能不在工作区里。
    if (artifactId) return;
    if (shareToken) {
      let cancelled = false;
      fetch(shareFileUrl(shareToken, filePath), { method: 'HEAD' })
        .then(res => {
          if (cancelled) return;
          const cl = res.headers.get('content-length');
          if (cl) setResolvedSize(Number(cl));
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }
    let cancelled = false;
    authFetch(`/api/file/download?path=${encodeURIComponent(filePath)}${ownerParam}`, { method: 'HEAD' })
      .then(res => {
        if (cancelled) return;
        const cl = res.headers.get('content-length');
        if (cl) setResolvedSize(Number(cl));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath, fileSize, ownerParam, artifactId, shareToken]);

  const previewType = getPreviewFileType(fileName);
  const isPreviewable = !!previewType;
  // 分享页只有 html/md/PDF 三种预览面板支持公开 shareToken 读取（其它面板仍走
  // 登录态 /api/file/read）；code/text/video 分享场景仍走新标签下载兜底。
  const isShareable = previewType === 'html' || previewType === 'md' || previewType === 'pdf';
  const visual = getFileTypeVisual(fileName);
  const TypeIcon = CATEGORY_ICON[visual.category];
  const isImage = visual.category === 'image';
  // artifact 图片有签名 URL 可用,直接 lightbox；其他类型暂只支持下载
  // （filePreview 依赖工作区路径,artifact 不适用）。
  const canOpenPreview = artifactId
    ? isImage
    : shareToken
      ? (isImage || (isShareable && !!filePreview))
      : (isImage || (isPreviewable && !!filePreview));

  const handleClick = () => {
    if (artifactId) {
      if (isImage) {
        void resolveArtifactUrl(artifactId)
          .then(setPreviewSrc)
          .catch(() => { /* 打开失败静默；下载按钮仍可用 */ });
      }
      return;
    }
    if (shareToken) {
      const url = shareFileUrl(shareToken, filePath);
      if (isImage) {
        setPreviewSrc(url);
      } else if (isShareable && filePreview) {
        // 分享页 md/PDF/html 走 FilePreviewDialog（分享页只有 dialog 通道，没有
        // side dock 面板），预览面板内部会通过 shareToken 读取快照内容。
        filePreview.openPreview(filePath, owner);
      }
      return;
    }
    if (isImage) {
      void resolveImageSrc(filePath, owner)
        .then(setPreviewSrc)
        .catch(() => setPreviewSrc(filePath));
    } else if (isPreviewable && filePreview) {
      // 普通附件卡使用默认 dialog；用户仍可在弹窗中主动切换到右侧预览栏。
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
            onClick={(e) => {
              e.stopPropagation();
              if (artifactId) {
                void artifactDownload(artifactId, fileName);
              } else if (shareToken) {
                void shareFileDownload(shareToken, filePath, fileName);
              } else {
                void authFetchDownload(filePath, fileName, owner);
              }
            }}
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

/**
 * 用户消息气泡内的附件 chip。
 * 有 relativePath（2026-07-14 起 transcript/WS meta 携带）时可点击：
 * 图片走 lightbox，可预览文件走 FilePreviewDialog（默认弹窗），其余类型直接下载。
 * 存量消息无 relativePath，保持静态展示。
 */
function UserAttachmentChip({ att, filePreview }: {
  att: { name: string; isImage?: boolean; relativePath?: string };
  filePreview: ReturnType<typeof useFilePreview> | null;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const Icon = att.isImage ? ImageIcon : Paperclip;
  const path = att.relativePath;
  const previewable = !att.isImage && !!getPreviewFileType(att.name) && !!filePreview;
  const clickable = !!path;

  const handleClick = () => {
    if (!path) return;
    if (att.isImage) {
      void resolveImageSrc(path, filePreview?.owner)
        .then(setPreviewSrc)
        .catch(() => setPreviewSrc(path));
    } else if (previewable && filePreview) {
      filePreview.openPreview(path, filePreview.owner);
    } else {
      void authFetchDownload(path, att.name, filePreview?.owner);
    }
  };

  return (
    <>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-xs text-muted-foreground",
          clickable && "cursor-pointer transition-colors hover:bg-foreground/[0.12] hover:text-foreground",
        )}
        onClick={clickable ? handleClick : undefined}
        role={clickable ? "button" : undefined}
        title={clickable
          ? (att.isImage ? "点击查看图片" : previewable ? "点击预览" : "点击下载")
          : undefined}
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="max-w-[200px] truncate">{att.name}</span>
      </span>
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
            alt={att.name}
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

/** 操作按钮组：TTS + 复制（+ 专职 Agent 会话的反馈按钮，context 缺省零渲染） */
function ActionButtons({
  text,
  ttsState,
  showTts,
  onTtsPlay,
  onTtsTogglePause,
  feedback,
}: {
  text: string;
  ttsState: TtsState;
  showTts: boolean;
  onTtsPlay: () => void;
  onTtsTogglePause: () => void;
  /** AI 文本消息传入（type==='text' && !streaming）；MessageFeedbackProvider 未挂载时按钮零渲染 */
  feedback?: { messageId: string; content: string };
}) {
  return (
    <>
      {showTts && (
        <TtsButton state={ttsState} onPlay={onTtsPlay} onTogglePause={onTtsTogglePause} />
      )}
      <CopyButton text={text} />
      {feedback && (
        <MessageFeedbackButton messageId={feedback.messageId} content={feedback.content} />
      )}
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
  onAskUserResponse?: (interactionId: string, answers: AskUserAnswers) => void;
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
  /** 是否显示思考、工具、技能/子任务等执行细节。 */
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
                  <UserAttachmentChip key={i} att={att} filePreview={filePreview} />
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
    // 流式渲染时抑制尾部未闭合的 [CITE] 半截标记（只裁尾部；FILE 保持现状）
    const displaySource = message.streaming ? stripPartialCiteMarker(voiceStripped) : voiceStripped;
    const segments = splitByMessageMarkers(displaySource);
    // Fallback: if no FILE/CITE markers, treat entire content as single text segment
    const hasMarkerSegments = segments.some(s => s.type !== 'text');
    const cleanContent = hasMarkerSegments ? '' : stripNonFileMediaMarkers(displaySource);
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
            {hasMarkerSegments ? (
              segments.map((seg, si) =>
                seg.type === 'file' ? (
                  <div key={`file-${si}`} className="my-2 not-prose">
                    <FileDownloadCard
                      fileName={seg.fileName}
                      filePath={seg.filePath}
                      fileSize={0}
                      filePreview={filePreview}
                      owner={message.owner}
                      shareToken={filePreview?.shareToken}
                    />
                  </div>
                ) : seg.type === 'citation' ? (
                  <div key={`cite-${si}`} className="my-1.5 not-prose">
                    <CitationCard doc={seg.doc} page={seg.page} label={seg.label} />
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
                  feedback={{ messageId: message.id, content: message.content }}
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
        {...(message.artifactId ? { artifactId: message.artifactId } : {})}
        shareToken={filePreview?.shareToken}
      />
    );
  }

  if (message.type === "thinking") {
    if (!debugMode) return <ExecutionHiddenPlaceholder isActive={message.streaming} durationMs={message.durationMs} />;
    return (
      <ThinkingBlock
        content={message.content}
        streaming={message.streaming}
        durationMs={message.durationMs}
      />
    );
  }

  if (message.type === "runtime_status") {
    return <RuntimeStatusBlock status={message.status} content={message.content} />;
  }

  if (message.type === "tool_use") {
    if (!debugMode) return <ExecutionHiddenPlaceholder isActive={message.streaming || message.executionStatus === "running" || (!message.resultReady && message.executionStatus !== "failed" && message.executionStatus !== "cancelled")} durationMs={message.durationMs} hasIssue={message.executionStatus === "failed"} />;
    return (
      <ToolBlock
        toolName={message.toolName}
        toolInput={message.toolInput}
        streaming={message.streaming}
        result={message.result}
        resultReady={message.resultReady}
        executionStatus={message.executionStatus}
        durationMs={message.durationMs}
        lastProgress={message.lastProgress}
        error={message.error}
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
    if (!debugMode) return <ExecutionHiddenPlaceholder isActive={message.status === "running"} hasIssue={message.status === "failed" || message.status === "timeout"} />;
    return (
      <SubagentBlock
        {...message}
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
          {isCancelled
            ? <Ban aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            : <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
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

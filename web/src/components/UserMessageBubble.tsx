import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Mic } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UserMessageBubbleProps {
  messageId: string;
  content: string;
  isVoiceTranscript?: boolean;
  isPlaying: boolean;
  isFailed: boolean;
  attachments?: ReactNode;
}

export function UserMessageBubble({
  messageId,
  content,
  isVoiceTranscript,
  isPlaying,
  isFailed,
  attachments,
}: UserMessageBubbleProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [isCollapsible, setIsCollapsible] = useState(false);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [messageId, content]);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || expanded) return;

    const measure = () => {
      setIsCollapsible(text.scrollHeight > text.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [content, expanded]);

  const collapsed = isCollapsible && !expanded;

  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-user-bubble px-3.5 py-2 msg-user-text text-foreground ring-1 ring-[rgba(232,132,58,0.22)] shadow-[0_1px_2px_rgba(232,132,58,0.10),0_4px_12px_-4px_rgba(232,132,58,0.20)]",
        collapsed && "cursor-pointer",
        isPlaying && "border-l-2 border-primary",
        isFailed && "opacity-60",
      )}
      onClick={collapsed ? () => setExpanded(true) : undefined}
      data-testid="user-message-bubble"
    >
      {isVoiceTranscript && (
        <span className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
          <Mic className="size-3" />
          <span>语音转文字</span>
        </span>
      )}
      {content ? (
        <div ref={textRef} className={!expanded ? "line-clamp-5" : undefined}>
          {content}
        </div>
      ) : null}
      {attachments}
      {isCollapsible && (
        <div className="mt-1 flex h-7 items-center justify-end">
          {expanded ? (
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded(false);
              }}
              aria-label="收起消息"
              title="收起消息"
            >
              <ChevronUp className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <span
              className="flex size-7 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm"
              aria-hidden="true"
            >
              <ChevronDown className="size-4" />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

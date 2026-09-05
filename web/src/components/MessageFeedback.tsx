import { useEffect, useRef, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { MESSAGE_FEEDBACK_COMMENT_MAX } from '@agent/shared';
import { cn } from '@/lib/utils';
import { sha256Hex, useMessageFeedback } from '@/contexts/MessageFeedbackContext';

/**
 * 消息「赞 / 踩」按钮 + 锚定评论弹层（专职 Agent 会话，2026-07 唯恩批次）
 *
 * - context 缺省（个人 Agent 会话 / 数据面不可用）→ 零渲染（兼容性红线）
 * - 点赞 → 直接提交 rating='up'（好评不需要理由，多一步弹层只会压低回收率）
 * - 点踩 → 锚定弹层（textarea ≤500 字 + 提交/取消，手写 absolute 弹层不引新依赖）
 * - 提交成功 → 对应按钮实心 + tooltip「已反馈」防连点；刷新后由 Provider 恢复已提交态
 *   （幂等键是 sha256(消息全文)，同一条消息只保留首次评分）
 */
export function MessageFeedbackButton({ messageId, content }: { messageId: string; content: string }) {
  const feedback = useMessageFeedback();
  const [hash, setHash] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = !!feedback;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    sha256Hex(content)
      .then((h) => { if (!cancelled) setHash(h); })
      .catch(() => { /* 环境无 crypto.subtle 时按钮保持可点，提交侧幂等兜底 */ });
    return () => { cancelled = true; };
  }, [content, active]);

  // 点击弹层外区域关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (!feedback) return null;

  const submitted = hash ? feedback.isSubmitted(hash) : false;
  const rating = hash ? feedback.submittedRating(hash) : null;

  const handleSubmit = async (nextRating: 'up' | 'down') => {
    if (submitting) return;
    setSubmitting(true);
    const ok = await feedback.submit({
      messageId,
      content,
      rating: nextRating,
      ...(nextRating === 'down' && comment.trim() ? { comment } : {}),
    });
    setSubmitting(false);
    if (ok) {
      setOpen(false);
      setComment('');
    }
  };

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        disabled={submitted || submitting}
        onClick={() => { void handleSubmit('up'); }}
        className={cn(
          'rounded-md p-1 transition-colors',
          rating === 'up'
            ? 'cursor-default text-primary'
            : submitted
              ? 'cursor-default text-muted-foreground/30'
              : 'text-muted-foreground/50 hover:text-muted-foreground',
        )}
        title={rating === 'up' ? '已反馈' : '这个回答有帮助'}
        aria-label={rating === 'up' ? '已反馈：这个回答有帮助' : '反馈这个回答有帮助'}
      >
        <ThumbsUp className={cn('size-3.5', rating === 'up' && 'fill-current')} />
      </button>
      <button
        type="button"
        disabled={submitted}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'rounded-md p-1 transition-colors',
          rating === 'down'
            ? 'cursor-default text-destructive'
            : submitted
              ? 'cursor-default text-muted-foreground/30'
              : 'text-muted-foreground/50 hover:text-muted-foreground',
        )}
        title={rating === 'down' ? '已反馈' : '这个回答有问题'}
        aria-label={rating === 'down' ? '已反馈：这个回答有问题' : '反馈这个回答有问题'}
      >
        <ThumbsDown className={cn('size-3.5', rating === 'down' && 'fill-current')} />
      </button>
      {open && !submitted && (
        <div
          ref={panelRef}
          className="absolute bottom-full right-0 z-40 mb-1.5 w-64 rounded-lg border bg-popover p-2.5 shadow-md"
        >
          <div className="mb-1.5 text-xs font-medium text-foreground">反馈这个回答的问题</div>
          <textarea
            autoComplete="off"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={MESSAGE_FEEDBACK_COMMENT_MAX}
            rows={3}
            placeholder="可选：说明问题（如答非所问、信息有误）"
            className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-foreground/30 focus:ring-0"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
              onClick={() => { setOpen(false); setComment(''); }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={submitting}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={() => { void handleSubmit('down'); }}
            >
              {submitting ? '提交中...' : '提交'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

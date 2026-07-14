import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { ApiSessionDetail, ApiTranscriptBlock } from '@agent/shared';
import { authFetch } from '@/lib/authFetch';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 100;

function blockLabel(block: ApiTranscriptBlock): string {
  if (block.kind === 'prompt') return '任务输入';
  if (block.kind === 'text') return 'Agent 输出';
  if (block.kind === 'thinking') return '思考';
  if (block.kind === 'tool_use') return block.toolName ? `调用 ${block.toolName}` : '工具调用';
  if (block.kind === 'tool_result') return block.toolName ? `${block.toolName} 结果` : '工具结果';
  return block.title || block.kind;
}

function blockTone(block: ApiTranscriptBlock): string {
  if (block.isError || block.executionStatus === 'failed') return 'border-destructive/30 bg-destructive/5';
  if (block.kind === 'text') return 'border-brand-200 bg-brand-50/40 dark:border-brand-800 dark:bg-brand-950/20';
  return 'border-border bg-muted/20';
}

interface SubagentTranscriptDialogProps {
  open: boolean;
  childSessionId: string;
  title: string;
  onClose: () => void;
}

export function SubagentTranscriptDialog({ open, childSessionId, title, onClose }: SubagentTranscriptDialogProps) {
  const [detail, setDetail] = useState<ApiSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    setVisibleCount(PAGE_SIZE);
    authFetch(`/api/sessions/${encodeURIComponent(childSessionId)}?silent=1`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        return response.json() as Promise<ApiSessionDetail>;
      })
      .then(setDetail)
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [childSessionId, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const blocks = detail?.blocks.slice(0, visibleCount) ?? [];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${title}完整过程`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">子任务完整过程 · {title}</h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{childSessionId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭子任务完整过程"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!detail && !error && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在读取子任务记录
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              无法读取子任务记录：{error}
            </div>
          )}
          {detail?.lastRunState?.error && (
            <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              终止原因：{detail.lastRunState.error}
            </div>
          )}
          {detail && blocks.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">该子任务还没有可展示的记录。</p>
          )}
          <div className="space-y-2">
            {blocks.map((block) => (
              <details
                key={block.id}
                className={cn('rounded-lg border px-3 py-2', blockTone(block))}
                open={block.kind === 'prompt' || block.kind === 'text'}
              >
                <summary className="cursor-pointer select-none text-xs font-medium text-foreground">
                  {blockLabel(block)}
                  {block.executionStatus ? ` · ${block.executionStatus}` : ''}
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-muted-foreground">
                  {block.content || '（无内容）'}
                </pre>
              </details>
            ))}
          </div>
          {detail && visibleCount < detail.blocks.length && (
            <button
              type="button"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
              className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              继续加载（已显示 {Math.min(visibleCount, detail.blocks.length)} / {detail.blocks.length}）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

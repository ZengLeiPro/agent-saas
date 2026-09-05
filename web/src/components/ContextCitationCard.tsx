import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import {
  contextCitationError,
  contextCitationPath,
  normalizeContextCitationDetail,
} from '@agent/shared';
import type { ContextCitationDetail } from '@agent/shared';
import { authFetch } from '@/lib/authFetch';
import { cn } from '@/lib/utils';
import { ContextCitationDrawer } from './ContextCitationDrawer';

export interface ContextCitationCardProps {
  contextId: string;
  label: string;
  /** 只能来自当前 Chat/MessageList 上下文，不读取 marker 内任何身份字段。 */
  sessionId?: string | null;
}

export function ContextCitationCard({ contextId, label, sessionId }: ContextCitationCardProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextCitationDetail | null>(null);
  const requestVersion = useRef(0);
  const disabled = !sessionId;

  useEffect(() => () => {
    requestVersion.current += 1;
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const currentRequest = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const response = await authFetch(contextCitationPath(sessionId, contextId), { method: 'GET' });
      if (!response.ok) throw new Error(contextCitationError(response.status));
      const normalized = normalizeContextCitationDetail(await response.json());
      if (!normalized) throw new Error('引用证据返回格式错误，请稍后重试。');
      if (requestVersion.current === currentRequest) setDetail(normalized);
    } catch (caught) {
      if (requestVersion.current === currentRequest) {
        setError(caught instanceof Error ? caught.message : '引用证据加载失败，请稍后重试。');
      }
    } finally {
      if (requestVersion.current === currentRequest) setLoading(false);
    }
  }, [contextId, sessionId]);

  const handleOpen = () => {
    if (disabled) return;
    setOpen(true);
    void load();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? 'Context 引用仅可在登录后的原会话中查看' : `查看 Context 引用：${label}`}
        aria-label={`Context 引用：${label}`}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-border',
        )}
      >
        <BookOpen className="size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>
      <ContextCitationDrawer
        open={open}
        label={label}
        detail={detail}
        loading={loading}
        error={error}
        onClose={() => setOpen(false)}
        onRetry={() => { void load(); }}
      />
    </>
  );
}

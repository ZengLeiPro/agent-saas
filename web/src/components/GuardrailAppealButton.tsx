/**
 * 门禁拒答申诉按钮（企业专家会话，2026-07 蓝图 v2 §4.4.2 员工申诉入口）
 *
 * - 员工在专家 bubble 下点「这个应该在范围内」，弹小窗填可选理由，
 *   提交后 POST /api/appeals，成功后 bubble 显示「✓ 已申诉」提示。
 * - 幂等：同一 guardrailEventId 只允许申诉 1 次（用 messageId 作为幂等键；
 *   服务端 B4 已按 guardrail_event_id 唯一约束落库）。
 * - context 缺省（个人 Agent 会话 / 数据面不可用）→ 零渲染，与
 *   MessageFeedbackContext 同一条兼容性红线。
 * - 已申诉集合在本 tab 会话生命周期内驻留（模块级 Set）；刷新页面重置
 *   到未申诉态，但服务端 409 会触发 UI 恢复到已申诉态，防止误提交。
 */
import { useEffect, useRef, useState } from 'react';
import { Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { authFetch } from '@/lib/authFetch';
import { useMessageFeedback } from '@/contexts/MessageFeedbackContext';

/** 已申诉的 guardrailEventId（跨 MessageItem 实例共享，避免复渲丢状态） */
const submittedAppeals = new Set<string>();
/** 观察者，通知已订阅的按钮实例 rerender */
const submittedListeners = new Set<() => void>();

function markSubmitted(id: string): void {
  submittedAppeals.add(id);
  for (const listener of submittedListeners) listener();
}

function useSubmittedAppeal(id: string): boolean {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const listener = () => forceRender((v) => v + 1);
    submittedListeners.add(listener);
    return () => { submittedListeners.delete(listener); };
  }, []);
  return submittedAppeals.has(id);
}

/** 测试钩子：清空 submittedAppeals，仅供单测使用（NODE_ENV=test 时暴露） */
export function __resetSubmittedAppealsForTest(): void {
  submittedAppeals.clear();
  submittedListeners.clear();
}

export interface GuardrailAppealButtonProps {
  /** 拒答 bubble 对应的消息 id；作为 guardrailEventId 幂等键传给后端 */
  messageId: string;
  /** 拒答话术原文，服务端会与门禁事件一起归档以便管理员定位 */
  content: string;
}

export function GuardrailAppealButton({ messageId }: GuardrailAppealButtonProps) {
  // 复用 MessageFeedbackContext 的 sessionId 语义：feedback context 非 null ⇔
  // 当前会话绑定 orgAgentId（App.tsx L210 已保证）。缺省时零渲染。
  // 注：content 目前未透传（服务端 /api/appeals 只按 guardrailEventId 归档，
  // 拒答原文由 event 侧关联查得）；保留 props 契约方便后续扩展 messagePreview。
  const feedback = useMessageFeedback();
  const submitted = useSubmittedAppeal(messageId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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

  if (submitted) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
        role="status"
      >
        <Flag aria-hidden="true" className="size-3.5" />
        已申诉，管理员会看到并调整
      </span>
    );
  }

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await authFetch('/api/appeals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guardrailEventId: messageId,
          ...(reason.trim() ? { appealReason: reason.trim() } : {}),
        }),
      });
      // 409 表示同 guardrailEventId 已申诉（幂等）：视为成功状态。
      if (res.ok || res.status === 409) {
        markSubmitted(messageId);
        setOpen(false);
        setReason('');
        return;
      }
      if (res.status === 503) {
        setErrorMsg('申诉服务暂不可用');
        return;
      }
      setErrorMsg('提交失败，请稍后重试');
    } catch {
      setErrorMsg('网络错误，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors',
          'text-muted-foreground hover:bg-muted hover:text-foreground',
          'border border-border/60',
        )}
        title="向管理员反馈：这个问题应该在专家范围内"
        aria-label="申诉：这个问题应该在专家范围内"
      >
        <Flag aria-hidden="true" className="size-3.5" />
        这个应该在范围内
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute bottom-full left-0 z-40 mb-1.5 w-72 rounded-lg border bg-popover p-2.5 shadow-md"
          role="dialog"
          aria-label="申诉这个拒答"
        >
          <div className="mb-1.5 text-xs font-medium text-foreground">
            申诉：这个应该在专家范围内
          </div>
          <textarea
            autoComplete="off"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="您认为为什么应该在范围内？（可选）"
            className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          {errorMsg && (
            <div className="mt-1.5 text-xs text-destructive">{errorMsg}</div>
          )}
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
              onClick={() => { setOpen(false); setReason(''); setErrorMsg(null); }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={submitting}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={() => { void handleSubmit(); }}
            >
              {submitting ? '提交中...' : '提交申诉'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

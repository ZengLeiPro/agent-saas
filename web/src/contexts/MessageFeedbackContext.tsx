/**
 * 消息反馈 Context（专职 Agent 会话点「踩」，2026-07 唯恩批次）
 *
 * - Provider 恒挂载（App.tsx），JSX 树形状恒定防 Layout 重挂（2026-07 审查 F8）；
 *   仅当前会话绑定 orgAgentId 时提供实值，否则 context=null，
 *   MessageFeedbackButton 零渲染——兼容性红线：个人 Agent 会话 UI 零变化。
 * - 幂等键 = sha256(消息全文)：消息 id 跨刷新不稳定（流式=随机 id，刷新后=line-N），
 *   进会话时 GET /api/feedback/session/:id 拉回本人已反馈的 contentHash 集合，
 *   前端用 crypto.subtle 对每条消息算 hash 匹配恢复「已反馈」态。
 * - 后端 503（file backend 未装配 PG）→ enabled=false，按钮隐藏。
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { authFetch } from '@/lib/authFetch';

export interface MessageFeedbackContextValue {
  enabled: boolean;
  /** 该消息内容 hash 是否已提交过反馈（防连点 + 刷新恢复） */
  isSubmitted: (contentHash: string) => boolean;
  /** 提交反馈；成功返回 true 并将 hash 记入已提交集合 */
  submit: (args: { messageId: string; content: string; comment?: string }) => Promise<boolean>;
}

const MessageFeedbackContext = createContext<MessageFeedbackContextValue | null>(null);

export function useMessageFeedback(): MessageFeedbackContextValue | null {
  return useContext(MessageFeedbackContext);
}

/** sha256 hex（与 server 端 createHash('sha256') 对齐） */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function MessageFeedbackProvider({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
  const [submittedHashes, setSubmittedHashes] = useState<ReadonlySet<string>>(new Set());
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setSubmittedHashes(new Set());
    setEnabled(true);
    if (!sessionId) return;
    authFetch(`/api/feedback/session/${encodeURIComponent(sessionId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 503) {
          setEnabled(false);
          return;
        }
        if (!res.ok) return;
        const data = await res.json() as { items?: Array<{ contentHash: string }> };
        if (cancelled) return;
        setSubmittedHashes(new Set((data.items ?? []).map((item) => item.contentHash)));
      })
      .catch(() => { /* 加载失败保持空集合，提交仍幂等 */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  const isSubmitted = useCallback(
    (contentHash: string) => submittedHashes.has(contentHash),
    [submittedHashes],
  );

  const submit = useCallback(async (args: { messageId: string; content: string; comment?: string }) => {
    if (!sessionId) return false;
    try {
      const res = await authFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messageId: args.messageId,
          content: args.content,
          ...(args.comment?.trim() ? { comment: args.comment.trim() } : {}),
        }),
      });
      if (res.status === 503) {
        setEnabled(false);
        return false;
      }
      if (!res.ok) return false;
      const data = await res.json() as { contentHash?: string };
      if (data.contentHash) {
        setSubmittedHashes((prev) => {
          const next = new Set(prev);
          next.add(data.contentHash!);
          return next;
        });
      }
      return true;
    } catch {
      return false;
    }
  }, [sessionId]);

  // JSX 树形状恒定（2026-07 审查 F8）：Provider 元素恒渲染，仅 value 在 null/实值间切换。
  // 无 org 会话或数据面不可用（file backend 503）→ value=null，按钮零渲染红线不变。
  const value: MessageFeedbackContextValue | null =
    sessionId && enabled ? { enabled, isSubmitted, submit } : null;
  return (
    <MessageFeedbackContext.Provider value={value}>
      {children}
    </MessageFeedbackContext.Provider>
  );
}

/**
 * 消息反馈 Context（对齐 `web/src/contexts/MessageFeedbackContext.tsx`）。
 *
 * - Provider 恒挂载、JSX 树形状恒定，仅 value 在 null / 实值之间切换；
 *   无会话或数据面 503 时 value=null，反馈入口零渲染（兼容性红线）。
 * - 幂等键 = sha256(消息全文)：消息 id 跨刷新不稳定（流式=随机 id，
 *   重载后=line-N），进会话时拉回本人已反馈的 contentHash 集合做匹配恢复。
 * - RN 没有 crypto.subtle，改用已在用的 @noble/hashes（与 server
 *   createHash('sha256') 同结果）。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  MESSAGE_FEEDBACK_PATH,
  authFetch,
  buildMessageFeedbackPayload,
  messageFeedbackOutcome,
  messageFeedbackSessionPath,
  parseSubmittedFeedbackHashes,
} from '@agent/shared';

export interface MessageFeedbackContextValue {
  enabled: boolean;
  /** 该消息内容 hash 是否已提交过反馈（防连点 + 重载恢复） */
  isSubmitted: (contentHash: string) => boolean;
  /** 提交反馈；成功返回 true 并把 hash 记入已提交集合 */
  submit: (args: { messageId: string; content: string; comment?: string }) => Promise<boolean>;
}

const MessageFeedbackContext = createContext<MessageFeedbackContextValue | null>(null);

export function useMessageFeedback(): MessageFeedbackContextValue | null {
  return useContext(MessageFeedbackContext);
}

/** sha256 hex（与 server createHash('sha256') 对齐） */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function MessageFeedbackProvider({
  sessionId,
  children,
}: {
  sessionId: string | null;
  children: React.ReactNode;
}) {
  const [submittedHashes, setSubmittedHashes] = useState<ReadonlySet<string>>(new Set());
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setSubmittedHashes(new Set());
    setEnabled(true);
    if (!sessionId) return;
    authFetch(messageFeedbackSessionPath(sessionId))
      .then(async (res) => {
        if (cancelled) return;
        const outcome = messageFeedbackOutcome(res.status);
        if (outcome === 'disabled') {
          setEnabled(false);
          return;
        }
        if (outcome !== 'ok') return;
        const hashes = parseSubmittedFeedbackHashes(await res.json());
        if (!cancelled) setSubmittedHashes(new Set(hashes));
      })
      .catch(() => {
        /* 加载失败保持空集合，提交侧仍然幂等 */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const isSubmitted = useCallback(
    (contentHash: string) => submittedHashes.has(contentHash),
    [submittedHashes],
  );

  const submit = useCallback(
    async (args: { messageId: string; content: string; comment?: string }) => {
      if (!sessionId) return false;
      try {
        const res = await authFetch(MESSAGE_FEEDBACK_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildMessageFeedbackPayload({ sessionId, ...args })),
        });
        const outcome = messageFeedbackOutcome(res.status);
        if (outcome === 'disabled') {
          setEnabled(false);
          return false;
        }
        if (outcome !== 'ok') return false;
        const data = (await res.json()) as { contentHash?: string };
        const hash = data.contentHash || sha256Hex(args.content);
        setSubmittedHashes((prev) => new Set(prev).add(hash));
        return true;
      } catch {
        return false;
      }
    },
    [sessionId],
  );

  // 树形状恒定：Provider 元素恒渲染，只有 value 在 null / 实值间切换。
  const value = useMemo<MessageFeedbackContextValue | null>(
    () => (sessionId && enabled ? { enabled, isSubmitted, submit } : null),
    [sessionId, enabled, isSubmitted, submit],
  );

  return (
    <MessageFeedbackContext.Provider value={value}>{children}</MessageFeedbackContext.Provider>
  );
}

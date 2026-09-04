/**
 * 会话级失败的恢复动作（与 Web `useChatAppState.retryMessage` 的语义对齐）。
 *
 * 两条路径：
 * 1. 失败的用户消息 → 原位重试（复用 clientMsgId，服务端幂等键消重）；
 * 2. 其余失败（system-error / 工具失败）→ 补发一句「继续」让 Agent 接着干，
 *    这正是客户面文案「Agent 开小差了，请发送「继续」」承诺的那一下。
 *
 * 放在独立 hook 而不是塞进 `useChatAppState`：那个 hook 已进 max-lines ratchet，
 * 新增逻辑一律外挂。发送走既有的 `setInput` + `sendMessage`（组合器只认 state 里的
 * 草稿），因此这里用一次「装填 → 下一帧发送」的两拍，不另开发送通道。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { MessageItem } from '@agent/shared';
import { useChatAppState } from '../contexts/ChatAppStateContext';

export const CONTINUE_TEXT = '继续';

export function useRuntimeRecovery(): (message: MessageItem) => void {
  const { input, setInput, sendMessage, retryMessage, loading } = useChatAppState();
  const armedRef = useRef(false);

  useEffect(() => {
    if (!armedRef.current || input !== CONTINUE_TEXT) return;
    armedRef.current = false;
    void sendMessage();
  }, [input, sendMessage]);

  return useCallback(
    (message: MessageItem) => {
      if (message.type === 'user') {
        retryMessage(message);
        return;
      }
      // 运行中不补发：这一轮还没结束，「继续」既无意义也会打断当前步骤。
      if (loading) return;
      armedRef.current = true;
      setInput(CONTINUE_TEXT);
    },
    [loading, retryMessage, setInput],
  );
}

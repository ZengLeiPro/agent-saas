/**
 * §5.4 `agent.open` 的落地端：切到 Agent 标签并把文本**预填**进输入框。
 *
 * 三条不能破：切标签、只预填、标注「来自《系统名》」（标注在 `lib/agentOpenBus.ts`
 * 组装时就加好了）。这里**没有任何发送出口** —— 定制项目若能直接让 Agent 发消息，
 * 就等于拿到了用户身份下的任意提示词注入。
 */
import { useEffect, useRef } from 'react';

import {
  consumePendingAgentOpen,
  subscribeAgentOpen,
  type AgentOpenRequest,
} from '@/lib/agentOpenBus';

export interface AgentOpenPrefillTarget {
  setInput: (value: string) => void;
  setActiveTab: (tab: 'chat') => void;
}

export function useAgentOpenPrefill(target: AgentOpenPrefillTarget): void {
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const apply = (request: AgentOpenRequest) => {
      targetRef.current.setActiveTab('chat');
      targetRef.current.setInput(request.text);
    };
    const unsubscribe = subscribeAgentOpen(apply);
    // 首屏直接停在定制软件标签时，`agent.open` 可能早于本 hook 挂载
    const pending = consumePendingAgentOpen();
    if (pending) apply(pending);
    return unsubscribe;
  }, []);
}

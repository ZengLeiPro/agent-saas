/**
 * 子任务完整过程的打开通道（对齐 `web/src/contexts/SubagentTranscriptContext.tsx`）。
 *
 * 面板本身由会话页承载（它才拿得到 MessageList），块内只负责发起请求：
 * 这样 blocks/ 不必反向依赖 MessageItem/MessageList，避免循环依赖——
 * 与 BusinessStepSectionView 用 renderItem 回调的理由是同一条。
 * context 缺省（未挂载宿主）时 useSubagentTranscript 返回 null，入口零渲染。
 */
import { createContext, useContext } from 'react';

export interface SubagentTranscriptTarget {
  childSessionId: string;
  /** 子任务类型，用于面板标题 */
  title: string;
}

export interface SubagentTranscriptContextValue {
  openTranscript: (target: SubagentTranscriptTarget) => void;
}

const SubagentTranscriptContext = createContext<SubagentTranscriptContextValue | null>(null);

export const SubagentTranscriptProvider = SubagentTranscriptContext.Provider;

export function useSubagentTranscript(): SubagentTranscriptContextValue | null {
  return useContext(SubagentTranscriptContext);
}

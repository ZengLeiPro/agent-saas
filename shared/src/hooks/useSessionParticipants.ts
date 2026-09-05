import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentProfile } from '../types/agent';
import type { SessionOwnerInfo, SessionParticipants } from '../types/session';

/**
 * 会话参与者（admin 查看他人会话时的身份信息；两端 `useChatAppState` 共同内核）：
 * owner 变化时先立刻给出 owner（头像/名字可用），Agent Profile 异步补齐；
 * owner 为空或就是当前用户时清空。
 */
export interface SessionParticipantsOptions {
  sessionOwner: SessionOwnerInfo | null | undefined;
  currentUsername: string | undefined;
  fetchAgentProfile: (username: string) => Promise<AgentProfile>;
}

export function useSessionParticipants(
  options: SessionParticipantsOptions,
): [SessionParticipants | null, Dispatch<SetStateAction<SessionParticipants | null>>] {
  const { sessionOwner, currentUsername, fetchAgentProfile } = options;
  const [sessionParticipants, setSessionParticipants] = useState<SessionParticipants | null>(null);
  useEffect(() => {
    const owner = sessionOwner;
    if (!owner || owner.username === currentUsername) {
      setSessionParticipants(null);
      return;
    }
    // 立即设置 owner 信息（头像/名字可用），agent 异步加载后补充
    setSessionParticipants({ owner, agent: null });
    let cancelled = false;
    fetchAgentProfile(owner.username)
      .then((agent) => {
        if (!cancelled) setSessionParticipants({ owner, agent });
      })
      .catch(() => {
        // agent 已为 null，无需额外处理
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOwner, currentUsername]);
  return [sessionParticipants, setSessionParticipants];
}

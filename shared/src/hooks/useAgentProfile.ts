import { useEffect, useState } from 'react';
import type { AgentProfile } from '../types/agent';

/**
 * 当前用户（或 admin 视角下被查看用户）的 Agent Profile（两端 `useChatAppState` 共同内核）。
 * `username` 为空即清空；`revision` 变化时按原样重拉（两端原本都以 `user` 对象为依赖）。
 */
export interface AgentProfileOptions {
  username: string | null;
  fetchAgentProfile: (username: string) => Promise<AgentProfile>;
  revision?: unknown;
}

export function useAgentProfile(options: AgentProfileOptions): AgentProfile | null {
  const { username, fetchAgentProfile, revision } = options;
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  useEffect(() => {
    if (!username) {
      setAgentProfile(null);
      return;
    }
    fetchAgentProfile(username)
      .then(setAgentProfile)
      .catch(() => setAgentProfile(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, revision]);
  return agentProfile;
}

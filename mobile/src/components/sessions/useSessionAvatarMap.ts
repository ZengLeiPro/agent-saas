/**
 * 会话行头像映射（username → avatar）。
 *
 * 模块级缓存消除 re-mount 闪烁（tab 切换等场景），AsyncStorage 缓存覆盖冷启动，
 * API 刷新在 auth 就绪后回写两级缓存。从 `(tabs)/chat/index.tsx` 抽出。
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchAgentProfile, fetchAllAgentProfiles, getPlatform } from '@agent/shared';

export interface AgentAvatarEntry {
  avatar?: string;
  avatarVersion?: number;
}

export type AgentAvatarMap = Record<string, AgentAvatarEntry>;

const AVATAR_CACHE_KEY = 'avatarMap';
let moduleCache: AgentAvatarMap = {};

export function useSessionAvatarMap(options: {
  isAdmin: boolean;
  username?: string;
}): AgentAvatarMap {
  const { isAdmin, username } = options;
  const [avatarMap, setAvatarMap] = useState<AgentAvatarMap>(moduleCache);

  const updateAvatarMap = useCallback((map: AgentAvatarMap) => {
    moduleCache = map;
    setAvatarMap(map);
  }, []);

  // 缓存读取 —— 不依赖 auth，挂载即刻执行，避免被 auth 状态变化取消
  useEffect(() => {
    if (Object.keys(moduleCache).length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await getPlatform().storage.getItem(AVATAR_CACHE_KEY);
        if (cancelled || !raw) return;
        const cached = JSON.parse(raw) as AgentAvatarMap;
        if (Object.keys(cached).length > 0) updateAvatarMap(cached);
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [updateAvatarMap]);

  // API 刷新 —— auth 就绪后拉最新数据并回写缓存
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let map: AgentAvatarMap = {};
        if (isAdmin) {
          const profiles = await fetchAllAgentProfiles();
          for (const profile of profiles) {
            map[profile.username] = {
              avatar: profile.avatar,
              avatarVersion: profile.avatarVersion,
            };
          }
        } else if (username) {
          const profile = await fetchAgentProfile(username);
          map = { [username]: { avatar: profile.avatar, avatarVersion: profile.avatarVersion } };
        }
        if (!cancelled && Object.keys(map).length > 0) {
          updateAvatarMap(map);
          void getPlatform().storage.setItem(AVATAR_CACHE_KEY, JSON.stringify(map));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, username, updateAvatarMap]);

  return avatarMap;
}

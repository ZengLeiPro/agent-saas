import { useCallback, useEffect, useState } from 'react';
import type { PoolSkillInfo, SkillInfo } from '@agent/shared';
import {
  fetchSkillPool,
  updatePoolVisibility,
  fetchCustomSkills,
  promoteSkill,
  deleteCustomSkill,
  syncSkillsApi,
} from '@agent/shared';
import { scheduleIdle } from '../lib/ric';

export function useAdminPoolSkills() {
  const [skills, setSkills] = useState<PoolSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchSkillPool();
      setSkills(data.skills || []);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => scheduleIdle(() => void refresh()), [refresh]);

  const toggleVisibility = useCallback(async (id: string, visible: boolean) => {
    setSkills(prev => prev.map(s => (s.id === id ? { ...s, visible } : s)));
    try {
      await updatePoolVisibility({ [id]: visible });
    } catch {
      setSkills(prev => prev.map(s => (s.id === id ? { ...s, visible: !visible } : s)));
      throw new Error('更新失败');
    }
  }, []);

  return { skills, loading, refresh, toggleVisibility };
}

export function useAdminCustomSkills() {
  const [users, setUsers] = useState<Record<string, SkillInfo[]>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchCustomSkills();
      setUsers(data.users || {});
    } catch {
      setUsers({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => scheduleIdle(() => void refresh()), [refresh]);

  const promote = useCallback(async (skillId: string, sourceUser: string) => {
    await promoteSkill(skillId, sourceUser);
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (username: string, skillId: string) => {
    await deleteCustomSkill(username, skillId);
    await refresh();
  }, [refresh]);

  const sync = useCallback(async (username?: string) => {
    await syncSkillsApi(username);
  }, []);

  return { users, loading, refresh, promote, remove, sync };
}

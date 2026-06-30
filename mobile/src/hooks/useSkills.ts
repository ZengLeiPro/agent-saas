import { useCallback, useEffect, useState } from 'react';
import type { MySkillsResponse, UserSkillInfo } from '@agent/shared';
import {
  fetchMySkills,
  updateMySelections,
  fetchUserSkills,
  updateUserSelections,
} from '@agent/shared';
import { scheduleIdle } from '../lib/ric';

export function useSkills(username?: string) {
  const [poolSkills, setPoolSkills] = useState<UserSkillInfo[]>([]);
  const [customSkills, setCustomSkills] = useState<UserSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selections, setSelections] = useState<Set<string>>(new Set());
  const [initialSelections, setInitialSelections] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const data: MySkillsResponse = username
        ? await fetchUserSkills(username)
        : await fetchMySkills();
      setPoolSkills(data.poolSkills || []);
      setCustomSkills(data.customSkills || []);
      const selected = new Set([
        ...(data.poolSkills || []).filter(s => s.selected).map(s => s.id),
        ...(data.customSkills || []).filter(s => s.selected).map(s => s.id),
      ]);
      setSelections(selected);
      setInitialSelections(new Set(selected));
    } catch {
      setPoolSkills([]);
      setCustomSkills([]);
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => scheduleIdle(() => void refresh()), [refresh]);

  const toggleSkill = useCallback((id: string) => {
    setSelections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dirty =
    selections.size !== initialSelections.size ||
    [...selections].some(id => !initialSelections.has(id));

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const arr = [...selections];
      if (username) {
        await updateUserSelections(username, arr);
      } else {
        await updateMySelections(arr);
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  }, [username, selections, refresh]);

  return {
    poolSkills,
    customSkills,
    loading,
    saving,
    selections,
    dirty,
    toggleSkill,
    save,
    refresh,
  };
}

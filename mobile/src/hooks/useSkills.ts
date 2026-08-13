import { useCallback, useEffect, useRef, useState } from 'react';
import type { MySkillsResponse, UserSkillInfo } from '@agent/shared';
import {
  fetchMySkills,
  updateMySelections,
  updateMySkillSelection,
  fetchUserSkills,
  updateUserSelections,
} from '@agent/shared';
import { scheduleIdle } from '../lib/ric';

export function useSkills(username?: string) {
  const [poolSkills, setPoolSkills] = useState<UserSkillInfo[]>([]);
  const [tenantSkills, setTenantSkills] = useState<UserSkillInfo[]>([]);
  const [customSkills, setCustomSkills] = useState<UserSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [selections, setSelections] = useState<Set<string>>(new Set());
  const [initialSelections, setInitialSelections] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const data: MySkillsResponse = username
        ? await fetchUserSkills(username)
        : await fetchMySkills();
      setPoolSkills(data.poolSkills || []);
      setTenantSkills(data.tenantSkills || []);
      setCustomSkills(data.customSkills || []);
      const selected = new Set([
        ...(data.poolSkills || []).filter(s => s.selected).map(s => s.id),
        ...(data.tenantSkills || []).filter(s => s.selected).map(s => s.id),
        ...(data.customSkills || []).filter(s => s.selected).map(s => s.id),
      ]);
      setSelections(selected);
      setInitialSelections(new Set(selected));
    } catch {
      setPoolSkills([]);
      setTenantSkills([]);
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
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const selectedSkills = [...selections];
      const allSkills = [...poolSkills, ...tenantSkills, ...customSkills];
      const changed = allSkills.filter(skill => selections.has(skill.id) !== initialSelections.has(skill.id));
      if (username || changed.some(skill => skill.selectionVersion === undefined)) {
        if (username) await updateUserSelections(username, selectedSkills);
        else await updateMySelections(selectedSkills);
      } else {
        let revision = changed[0]?.selectionVersion ?? 0;
        for (const skill of changed) {
          const result = await updateMySkillSelection(skill.id, selections.has(skill.id), revision);
          revision = result.selectionVersion;
        }
      }
      await refresh();
    } catch (error) {
      await refresh();
      throw error;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [username, selections, initialSelections, poolSkills, tenantSkills, customSkills, refresh]);

  return {
    poolSkills,
    tenantSkills,
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

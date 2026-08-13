import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMySkills,
  fetchUserSkills,
  SkillSelectionConflictError,
  updateMySelections,
  updateMySkillSelection,
  updateUserSelections,
} from "@agent/shared";
import type { MySkillsResponse } from "@agent/shared";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";

let cachedData: Record<string, MySkillsResponse> = {};

export function useMySkills(username?: string) {
  const key = username || "__me__";
  const [data, setData] = useState<MySkillsResponse | null>(cachedData[key] ?? null);
  const [loading, setLoading] = useState(cachedData[key] == null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const result = username ? await fetchUserSkills(username) : await fetchMySkills();
      cachedData[key] = result;
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [username, key]);

  useEffect(() => {
    if (cachedData[key]) {
      setData(cachedData[key]);
      setLoading(false);
      return;
    }
    void refresh();
  }, [key, refresh]);

  useEffect(() => {
    const busKey = `skills:${key}`;
    registerRefresh(busKey, refresh);
    return () => unregisterRefresh(busKey);
  }, [key, refresh]);

  const saveSelection = useCallback(async (skillId: string, selected: boolean) => {
    if (savingRef.current) return;
    const skills = data
      ? [...data.poolSkills, ...(data.tenantSkills ?? []), ...data.customSkills]
      : [];
    const target = skills.find(skill => skill.id === skillId);
    if (!target) throw new Error('技能状态已变化，请刷新后重试');

    savingRef.current = true;
    setSaving(true);
    try {
      if (username) {
        const selectedSkills = skills
          .filter(skill => skill.id === skillId ? selected : skill.selected)
          .map(skill => skill.id);
        await updateUserSelections(username, selectedSkills);
        await refresh();
        return;
      }

      if (target.selectionVersion === undefined) {
        const selectedSkills = skills
          .filter(skill => skill.id === skillId ? selected : skill.selected)
          .map(skill => skill.id);
        await updateMySelections(selectedSkills);
        await refresh();
        return;
      }

      const result = await updateMySkillSelection(skillId, selected, target.selectionVersion);
      setData((current) => {
        if (!current) return current;
        const update = (items: MySkillsResponse["poolSkills"]) => items.map((skill) => ({
          ...skill,
          ...(skill.id === skillId ? { selected: result.selected } : {}),
          selectionVersion: result.selectionVersion,
        }));
        const next: MySkillsResponse = {
          poolSkills: update(current.poolSkills),
          tenantSkills: update(current.tenantSkills ?? []),
          customSkills: update(current.customSkills),
        };
        cachedData[key] = next;
        return next;
      });
    } catch (err) {
      if (err instanceof SkillSelectionConflictError) {
        if (err.current) {
          setData((current) => {
            if (!current) return current;
            const update = (items: MySkillsResponse["poolSkills"]) => items.map((skill) => ({
              ...skill,
              ...(skill.id === err.current!.skillId ? { selected: err.current!.selected } : {}),
              selectionVersion: err.current!.selectionVersion,
            }));
            const next: MySkillsResponse = {
              poolSkills: update(current.poolSkills),
              tenantSkills: update(current.tenantSkills ?? []),
              customSkills: update(current.customSkills),
            };
            cachedData[key] = next;
            return next;
          });
        }
        await refresh();
      }
      throw err;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [data, username, refresh, key]);

  return { data, loading, error, saving, refresh, saveSelection };
}

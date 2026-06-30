import { useCallback, useEffect, useState } from "react";
import {
  fetchMySkills,
  fetchUserSkills,
  updateMySelections,
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

  const saveSelections = useCallback(async (selectedSkills: string[]) => {
    setSaving(true);
    try {
      if (username) {
        await updateUserSelections(username, selectedSkills);
      } else {
        await updateMySelections(selectedSkills);
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  }, [username, refresh]);

  return { data, loading, error, saving, refresh, saveSelections };
}

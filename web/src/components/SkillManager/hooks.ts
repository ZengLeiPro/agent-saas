import { useCallback, useEffect, useState } from "react";
import {
  fetchSkillPool,
  updatePoolVisibility,
  fetchCustomSkills,
  promoteSkill,
  deleteCustomSkill,
  fetchCustomSkillDocument,
  updateCustomSkillDocument,
  syncSkillsApi,
} from "@agent/shared";
import type { PoolSkillInfo, CustomSkillsResponse, SkillDocumentResponse } from "@agent/shared";
import { registerRefresh, unregisterRefresh } from "@/lib/refreshBus";

let cachedPool: PoolSkillInfo[] | null = null;
let cachedCustom: CustomSkillsResponse | null = null;

export function useSkillAdmin() {
  const [poolSkills, setPoolSkills] = useState<PoolSkillInfo[]>(cachedPool ?? []);
  const [customData, setCustomData] = useState<CustomSkillsResponse | null>(cachedCustom);
  const [loading, setLoading] = useState(cachedPool === null);
  const [error, setError] = useState<string | null>(null);

  const refreshPool = useCallback(async () => {
    try {
      const res = await fetchSkillPool();
      cachedPool = res.skills;
      setPoolSkills(res.skills);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshCustom = useCallback(async () => {
    try {
      const res = await fetchCustomSkills();
      cachedCustom = res;
      setCustomData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([refreshPool(), refreshCustom()]);
    setLoading(false);
  }, [refreshPool, refreshCustom]);

  useEffect(() => {
    if (cachedPool && cachedCustom) {
      setLoading(false);
      void Promise.all([refreshPool(), refreshCustom()]);
      return;
    }
    void refresh();
  }, [refresh, refreshPool, refreshCustom]);

  useEffect(() => {
    registerRefresh("skillAdmin", refresh);
    return () => unregisterRefresh("skillAdmin");
  }, [refresh]);

  const updateVisibility = useCallback(async (updates: Record<string, boolean>) => {
    await updatePoolVisibility(updates);
    await refreshPool();
  }, [refreshPool]);

  const handlePromote = useCallback(async (skillId: string, sourceUser: string) => {
    await promoteSkill(skillId, sourceUser);
    await refresh();
  }, [refresh]);

  const handleDelete = useCallback(async (username: string, skillId: string) => {
    await deleteCustomSkill(username, skillId);
    await refreshCustom();
  }, [refreshCustom]);

  const handleFetchDocument = useCallback(async (username: string, skillId: string): Promise<SkillDocumentResponse> => {
    return fetchCustomSkillDocument(username, skillId);
  }, []);

  const handleUpdateDocument = useCallback(async (username: string, skillId: string, content: string) => {
    await updateCustomSkillDocument(username, skillId, content);
    await refreshCustom();
  }, [refreshCustom]);

  const handleSync = useCallback(async (username?: string) => {
    await syncSkillsApi(username);
    await refresh();
  }, [refresh]);

  return {
    poolSkills,
    customData,
    loading,
    error,
    refresh,
    updateVisibility,
    promoteSkill: handlePromote,
    deleteCustomSkill: handleDelete,
    fetchCustomSkillDocument: handleFetchDocument,
    updateCustomSkillDocument: handleUpdateDocument,
    syncSkills: handleSync,
  };
}

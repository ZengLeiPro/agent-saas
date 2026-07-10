/**
 * 员工侧专职 Agent 列表（GET /api/org-agents/mine，2026-07 唯恩批次）
 *
 * 模块级缓存（仿 UserManager/hooks.ts useUsers）：侧边栏两个布局挂载点共享
 * 一份数据，避免重复请求。未被指派任何专职 Agent 时返回空数组 → 侧边栏
 * section 零渲染（兼容性红线）。
 */
import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { registerRefresh, unregisterRefresh } from '@/lib/refreshBus';
import type { OrgAgentSummary } from '@agent/shared';

let cachedOrgAgents: OrgAgentSummary[] | null = null;

export function useOrgAgents() {
  const [agents, setAgents] = useState<OrgAgentSummary[]>(cachedOrgAgents ?? []);
  const [loading, setLoading] = useState(cachedOrgAgents === null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/org-agents/mine');
      if (!res.ok) return;
      const data = await res.json();
      const list: OrgAgentSummary[] = Array.isArray(data) ? data : [];
      cachedOrgAgents = list;
      setAgents(list);
    } catch {
      // 加载失败保持现状（缺省空数组 = 零渲染）
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedOrgAgents) { setLoading(false); return; }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    registerRefresh('org-agents-mine', refresh);
    return () => unregisterRefresh('org-agents-mine');
  }, [refresh]);

  return { agents, loading, refresh };
}

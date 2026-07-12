/**
 * 员工侧专职 Agent 列表（GET /api/org-agents/mine，2026-07 唯恩批次）
 *
 * 未被指派任何专职 Agent 时返回空数组 → 侧边栏 section 零渲染。
 * 账号切换时必须先清空旧账号数据再拉取，避免专职 Agent 摘要跨账号残留。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { authFetch } from '@/lib/authFetch';
import { registerRefresh, unregisterRefresh } from '@/lib/refreshBus';
import type { OrgAgentSummary } from '@agent/shared';

export function useOrgAgents() {
  const { user } = useAuth();
  const ownerKey = user ? `${user.tenantId}:${user.id}` : 'anonymous';
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [agents, setAgents] = useState<OrgAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const requestOwnerKey = ownerKey;
    try {
      const res = await authFetch('/api/org-agents/mine');
      if (!res.ok) return;
      const data = await res.json();
      const list: OrgAgentSummary[] = Array.isArray(data) ? data : [];
      if (ownerKeyRef.current !== requestOwnerKey) return;
      setAgents(list);
    } catch {
      // 加载失败保持现状（缺省空数组 = 零渲染）
    } finally {
      if (ownerKeyRef.current === requestOwnerKey) setLoading(false);
    }
  }, [ownerKey]);

  useEffect(() => {
    setAgents([]);
    setLoading(true);
    void refresh();
  }, [ownerKey, refresh]);

  useEffect(() => {
    registerRefresh('org-agents-mine', refresh);
    return () => unregisterRefresh('org-agents-mine');
  }, [refresh]);

  return { agents, loading, refresh };
}

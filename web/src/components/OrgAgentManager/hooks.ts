/**
 * 专职 Agent 管理端 hooks（组织管理 modal「专职 Agent」section）
 *
 * 数据源 /api/org-agents CRUD：组织 admin 天然本租户；平台 admin 传 tenantId
 * 过滤到当前切换的组织。skill 多选数据源 = 租户可用 skill 清单
 * （平台池启用给该租户的 + 租户自有的）。
 */
import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { fetchTenantOwnSkills, fetchTenantSkillPool } from '@agent/shared';
import type { SkillInfo } from '@agent/shared';
import type { OrgAgentRecord } from './types';

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error || fallback;
}

export function useOrgAgentAdmin(tenantId?: string) {
  const [agents, setAgents] = useState<OrgAgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
      const res = await authFetch(`/api/org-agents${query}`);
      if (!res.ok) throw new Error(await readError(res, '获取企业专家失败'));
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async (input: Omit<OrgAgentRecord, 'id' | 'tenantId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>) => {
    const res = await authFetch('/api/org-agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(tenantId ? { tenantId } : {}), ...input }),
    });
    if (!res.ok) throw new Error(await readError(res, '创建企业专家失败'));
    await refresh();
  }, [refresh, tenantId]);

  const update = useCallback(async (id: string, patch: Partial<Omit<OrgAgentRecord, 'id' | 'tenantId'>>) => {
    const res = await authFetch(`/api/org-agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(await readError(res, '更新企业专家失败'));
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    const res = await authFetch(`/api/org-agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await readError(res, '删除企业专家失败'));
    await refresh();
  }, [refresh]);

  const uploadAvatar = useCallback(async (id: string, file: File): Promise<{ avatar: string; avatarVersion: number }> => {
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await authFetch(`/api/org-agents/${encodeURIComponent(id)}/avatar`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error(await readError(res, '上传头像失败'));
    const data = await res.json() as { avatar: string; avatarVersion: number };
    await refresh();
    return data;
  }, [refresh]);

  return { agents, loading, error, refresh, create, update, remove, uploadAvatar };
}

/** 租户可用 skill 清单：平台池启用给该租户的 + 租户自有启用的（skill 白名单多选数据源） */
export function useTenantSkillOptions(tenantId?: string) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) {
      setSkills([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchTenantSkillPool(tenantId).catch(() => ({ skills: [] })),
      fetchTenantOwnSkills(tenantId).catch(() => ({ skills: [] })),
    ])
      .then(([pool, own]) => {
        if (cancelled) return;
        const merged = new Map<string, SkillInfo>();
        for (const skill of pool.skills) {
          if (skill.enabled) merged.set(skill.id, { id: skill.id, name: skill.name, description: skill.description });
        }
        for (const skill of own.skills) {
          if (skill.enabled) merged.set(skill.id, { id: skill.id, name: skill.name, description: skill.description });
        }
        setSkills(Array.from(merged.values()));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId]);

  return { skills, loading };
}

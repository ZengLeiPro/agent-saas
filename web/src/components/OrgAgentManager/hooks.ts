/**
 * 组织 Agent 管理 hooks。
 *
 * 列表继续读取 legacy projection；所有配置写入改走治理 Agent Version / Assignment，
 * legacy store 只承担运行时兼容投影，不再作为管理真源。
 */
import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { fetchTenantOwnSkills, fetchTenantSkillPool } from '@agent/shared';
import type { OrgAgentRuntimePolicy, SkillInfo } from '@agent/shared';
import type { OrgAgentRecord } from './types';

export interface ManagedAgentResource {
  agentId: string;
  tenantId: string;
  kind: 'org_agent';
  ownerUserId: string;
  status: 'draft' | 'enabled' | 'disabled' | 'archived';
  currentVersionId?: string;
  revision: number;
  updatedAt?: string;
}

export interface ManagedOrgAgentDefinition {
  schemaVersion: 1;
  name: string;
  avatar?: string;
  description: string;
  starterPrompts: string[];
  instructions: string;
  skills: Array<{ id: string }>;
  knowledge: string[];
  runtime: OrgAgentRuntimePolicy;
  guardrail: {
    mode: 'off' | 'shadow' | 'enforce';
    enabled: boolean;
    scopeDescription: string;
    rejectionMessage: string;
    strictness: 'strict' | 'lenient';
  };
  source: 'governance';
}

export interface GovernanceAssignmentDraft {
  assigneeType: 'everyone' | 'user' | 'directory_group';
  assigneeId?: string;
  effect: 'allow' | 'deny';
  origin?: 'direct' | 'policy_default';
}

export interface GovernanceAssignmentSet {
  version: number;
  assignments: Array<GovernanceAssignmentDraft & { assignmentId?: string }>;
}

export interface OrgAgentConfiguration {
  resource: ManagedAgentResource;
  version: {
    versionId: string;
    definition: ManagedOrgAgentDefinition;
  } | null;
  assignment: GovernanceAssignmentSet;
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const data = await res.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    changed?: boolean;
    impact?: { blockers?: string[] };
  };
  const suffix = data.code ? `（${data.code}）` : '';
  const changed = data.changed ? '；部分变更已生效，请刷新后重试' : '';
  return new Error(`${data.error || fallback}${suffix}${changed}`);
}

async function requestJson<T>(path: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) throw await readError(res, fallback);
  return await res.json() as T;
}

function tenantQuery(tenantId?: string): string {
  return tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
}

function normalizedAssignments(items: GovernanceAssignmentDraft[]): string[] {
  return items.map(item => [item.assigneeType, item.assigneeId ?? '', item.effect].join(':')).sort();
}

function assignmentsEqual(left: GovernanceAssignmentDraft[], right: GovernanceAssignmentDraft[]): boolean {
  const a = normalizedAssignments(left);
  const b = normalizedAssignments(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function useOrgAgentAdmin(tenantId?: string) {
  const [agents, setAgents] = useState<OrgAgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/org-agents${tenantQuery(tenantId)}`);
      if (!res.ok) throw await readError(res, '获取企业专家失败');
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

  const loadConfiguration = useCallback(async (id: string): Promise<OrgAgentConfiguration> => {
    const [agentResponse, assignmentResponse] = await Promise.all([
      requestJson<{ resource: ManagedAgentResource; version: OrgAgentConfiguration['version'] }>(
        `/api/governance/resources/agents/${encodeURIComponent(id)}${tenantQuery(tenantId)}`,
        undefined,
        '读取企业专家治理配置失败',
      ),
      authFetch(
        `/api/governance/access/assignments/org_agent/${encodeURIComponent(id)}${tenantQuery(tenantId)}`,
      ),
    ]);
    let assignment: GovernanceAssignmentSet = { version: 0, assignments: [] };
    if (assignmentResponse.ok) {
      assignment = await assignmentResponse.json() as GovernanceAssignmentSet;
    } else if (assignmentResponse.status !== 404) {
      throw await readError(assignmentResponse, '读取企业专家访问范围失败');
    }
    return { ...agentResponse, assignment };
  }, [tenantId]);

  const createResource = useCallback(async (): Promise<ManagedAgentResource> => (
    await requestJson<ManagedAgentResource>(
      '/api/governance/resources/agents',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(tenantId ? { tenantId } : {}),
          kind: 'org_agent',
        }),
      },
      '创建企业专家治理资源失败',
    )
  ), [tenantId]);

  const publishDefinition = useCallback(async (
    resource: ManagedAgentResource,
    definition: ManagedOrgAgentDefinition,
  ): Promise<{ resource: ManagedAgentResource; version: OrgAgentConfiguration['version'] }> => {
    const path = `/api/governance/resources/agents/${encodeURIComponent(resource.agentId)}/versions`;
    const reason = `更新企业专家 ${definition.name}`;
    const change = { expectedRevision: resource.revision, definition, reason };
    const preview = await requestJson<{
      previewId: string;
      baselineDigest: string;
      expiresAt: string;
      canCommit: boolean;
      impact?: { blockers?: string[] };
    }>(`${path}/preview${tenantQuery(tenantId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    }, '预检企业专家配置失败');
    if (!preview.canCommit) {
      throw new Error(`企业专家配置暂不可发布：${preview.impact?.blockers?.join('、') || '治理投影不可用'}`);
    }
    return await requestJson<{ resource: ManagedAgentResource; version: OrgAgentConfiguration['version'] }>(
      `${path}${tenantQuery(tenantId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...change,
          previewId: preview.previewId,
          baselineDigest: preview.baselineDigest,
          expiresAt: preview.expiresAt,
        }),
      },
      '发布企业专家配置失败',
    );
  }, [tenantId]);

  const setGovernedStatus = useCallback(async (
    resource: ManagedAgentResource,
    enabled: boolean,
  ): Promise<ManagedAgentResource> => {
    const status = enabled ? 'enabled' : 'disabled';
    if (resource.status === status) return resource;
    const path = `/api/governance/resources/agents/${encodeURIComponent(resource.agentId)}/status`;
    const change = {
      expectedRevision: resource.revision,
      status,
      reason: `${enabled ? '启用' : '停用'}企业专家 ${resource.agentId}`,
    };
    const preview = await requestJson<{
      previewId: string;
      baselineDigest: string;
      expiresAt: string;
      canCommit: boolean;
      impact?: { blockers?: string[] };
    }>(`${path}/preview${tenantQuery(tenantId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    }, '预检企业专家状态失败');
    if (!preview.canCommit) {
      throw new Error(`企业专家状态暂不可修改：${preview.impact?.blockers?.join('、') || '治理投影不可用'}`);
    }
    return await requestJson<ManagedAgentResource>(`${path}${tenantQuery(tenantId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...change,
        previewId: preview.previewId,
        baselineDigest: preview.baselineDigest,
        expiresAt: preview.expiresAt,
      }),
    }, enabled ? '启用企业专家失败' : '停用企业专家失败');
  }, [tenantId]);

  const saveAssignments = useCallback(async (
    id: string,
    current: GovernanceAssignmentSet,
    assignments: GovernanceAssignmentDraft[],
  ): Promise<GovernanceAssignmentSet> => {
    if (assignmentsEqual(current.assignments, assignments)) return current;
    const path = `/api/governance/access/assignments/org_agent/${encodeURIComponent(id)}`;
    const change = { expectedVersion: current.version, assignments };
    const preview = await requestJson<{
      previewId: string;
      baselineDigest: string;
      expiresAt: string;
    }>(`${path}/preview${tenantQuery(tenantId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    }, '预检企业专家访问范围失败');
    return await requestJson<GovernanceAssignmentSet>(`${path}${tenantQuery(tenantId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...change,
        previewId: preview.previewId,
        baselineDigest: preview.baselineDigest,
        expiresAt: preview.expiresAt,
      }),
    }, '保存企业专家访问范围失败');
  }, [tenantId]);

  const saveConfiguration = useCallback(async (input: {
    configuration: OrgAgentConfiguration | null;
    definition: ManagedOrgAgentDefinition;
    enabled: boolean;
    assignments: GovernanceAssignmentDraft[];
  }): Promise<string> => {
    const initialResource = input.configuration?.resource ?? await createResource();
    const published = await publishDefinition(initialResource, input.definition);
    try {
      const statusResource = await setGovernedStatus(published.resource, input.enabled);
      await saveAssignments(
        statusResource.agentId,
        input.configuration?.assignment ?? { version: 0, assignments: [] },
        input.assignments,
      );
      await new Promise(resolve => window.setTimeout(resolve, 120));
      await refresh();
      return statusResource.agentId;
    } catch (error) {
      await refresh();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`企业专家版本已发布，但后续配置未全部保存：${detail}`);
    }
  }, [createResource, publishDefinition, refresh, saveAssignments, setGovernedStatus]);

  const updateStatus = useCallback(async (id: string, enabled: boolean) => {
    const configuration = await loadConfiguration(id);
    await setGovernedStatus(configuration.resource, enabled);
    await new Promise(resolve => window.setTimeout(resolve, 120));
    await refresh();
  }, [loadConfiguration, refresh, setGovernedStatus]);

  const uploadAvatar = useCallback(async (
    id: string,
    file: File,
  ): Promise<{ avatar: string; avatarPath?: string; avatarVersion: number }> => {
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await authFetch(`/api/org-agents/${encodeURIComponent(id)}/avatar`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw await readError(res, '上传头像失败');
    const data = await res.json() as { avatar: string; avatarPath?: string; avatarVersion: number };
    await refresh();
    return data;
  }, [refresh]);

  return {
    agents,
    loading,
    error,
    refresh,
    loadConfiguration,
    saveConfiguration,
    updateStatus,
    uploadAvatar,
  };
}

/** 租户可用 skill 清单：平台池启用给该租户的 + 租户自有启用的。 */
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

/** 组织知识当前映射为 tenant-owned Skill；单独列出，避免管理员手填技术 ID。 */
export function useTenantKnowledgeOptions(tenantId?: string) {
  const [knowledge, setKnowledge] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) {
      setKnowledge([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchTenantOwnSkills(tenantId)
      .then(result => {
        if (cancelled) return;
        setKnowledge(result.skills
          .filter(skill => skill.enabled)
          .map(skill => ({ id: skill.id, name: skill.name, description: skill.description })));
      })
      .catch(() => { if (!cancelled) setKnowledge([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId]);

  return { knowledge, loading };
}

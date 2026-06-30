import { authFetch } from './authFetch';
import type {
  MySkillsResponse,
  SkillPoolResponse,
  TenantSkillPoolResponse,
  CustomSkillsResponse,
  SkillImportResponse,
  SkillDocumentResponse,
} from '../types/skill';

// ── 用户自助 ──────────────────────────────────────────────

export async function fetchMySkills(): Promise<MySkillsResponse> {
  const res = await authFetch('/api/skills/me');
  if (!res.ok) throw new Error(`Failed to fetch my skills: ${res.status}`);
  return res.json() as Promise<MySkillsResponse>;
}

export async function updateMySelections(selectedSkills: string[]): Promise<void> {
  const res = await authFetch('/api/skills/me/selections', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedSkills }),
  });
  if (!res.ok) throw new Error(`Failed to update skill selections: ${res.status}`);
}

export async function fetchUserSkills(username: string): Promise<MySkillsResponse> {
  const res = await authFetch(`/api/skills/users/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`Failed to fetch user skills: ${res.status}`);
  return res.json() as Promise<MySkillsResponse>;
}

export async function updateUserSelections(username: string, selectedSkills: string[]): Promise<void> {
  const res = await authFetch(`/api/skills/users/${encodeURIComponent(username)}/selections`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedSkills }),
  });
  if (!res.ok) throw new Error(`Failed to update user skill selections: ${res.status}`);
}

// ── Admin 管理 ────────────────────────────────────────────

export async function fetchSkillPool(): Promise<SkillPoolResponse> {
  const res = await authFetch('/api/skills/pool');
  if (!res.ok) throw new Error(`Failed to fetch skill pool: ${res.status}`);
  return res.json() as Promise<SkillPoolResponse>;
}

export async function updatePoolVisibility(visibility: Record<string, boolean>): Promise<void> {
  const res = await authFetch('/api/skills/pool/visibility', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(visibility),
  });
  if (!res.ok) throw new Error(`Failed to update pool visibility: ${res.status}`);
}

export async function fetchTenantSkillPool(tenantId: string): Promise<TenantSkillPoolResponse> {
  const res = await authFetch(`/api/skills/tenants/${encodeURIComponent(tenantId)}/pool`);
  if (!res.ok) throw new Error(`Failed to fetch tenant skill pool: ${res.status}`);
  return res.json() as Promise<TenantSkillPoolResponse>;
}

export async function updateTenantSkillSelections(tenantId: string, enabledSkills: string[]): Promise<void> {
  const res = await authFetch(`/api/skills/tenants/${encodeURIComponent(tenantId)}/pool/selections`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabledSkills }),
  });
  if (!res.ok) throw new Error(`Failed to update tenant skill selections: ${res.status}`);
}

export async function fetchCustomSkills(): Promise<CustomSkillsResponse> {
  const res = await authFetch('/api/skills/custom');
  if (!res.ok) throw new Error(`Failed to fetch custom skills: ${res.status}`);
  return res.json() as Promise<CustomSkillsResponse>;
}

export async function promoteSkill(skillId: string, sourceUser: string): Promise<void> {
  const res = await authFetch(`/api/skills/custom/${encodeURIComponent(skillId)}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUser }),
  });
  if (!res.ok) throw new Error(`Failed to promote skill: ${res.status}`);
}

export async function fetchCustomSkillDocument(username: string, skillId: string): Promise<SkillDocumentResponse> {
  const res = await authFetch(`/api/skills/custom/${encodeURIComponent(username)}/${encodeURIComponent(skillId)}/document`);
  if (!res.ok) throw new Error(`Failed to fetch custom skill document: ${res.status}`);
  return res.json() as Promise<SkillDocumentResponse>;
}

export async function updateCustomSkillDocument(username: string, skillId: string, content: string): Promise<void> {
  const res = await authFetch(`/api/skills/custom/${encodeURIComponent(username)}/${encodeURIComponent(skillId)}/document`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    let message = `Failed to update custom skill document: ${res.status}`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
}

export async function deleteCustomSkill(username: string, skillId: string): Promise<void> {
  const res = await authFetch(`/api/skills/custom/${encodeURIComponent(username)}/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to delete custom skill: ${res.status}`);
}

export async function syncSkills(username?: string): Promise<void> {
  const url = username
    ? `/api/skills/sync?username=${encodeURIComponent(username)}`
    : '/api/skills/sync';
  const res = await authFetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to sync skills: ${res.status}`);
}

export async function importMySkill(files: File[]): Promise<SkillImportResponse> {
  const formData = new FormData();
  for (const file of files) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    formData.append('files', file, relativePath);
  }
  const res = await authFetch('/api/skills/me/import', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    let message = `Failed to import skill: ${res.status}`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<SkillImportResponse>;
}

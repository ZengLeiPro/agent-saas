import { authFetch } from './authFetch';
import type { AgentProfile, AgentProfileDetail } from '../types/agent';

export async function fetchAgentProfile(username: string): Promise<AgentProfileDetail> {
  const res = await authFetch(`/api/agents/${username}`);
  if (!res.ok) throw new Error(`Failed to fetch agent profile: ${res.status}`);
  return res.json() as Promise<AgentProfileDetail>;
}

export async function fetchAllAgentProfiles(options?: { scope?: 'currentTenant' }): Promise<AgentProfile[]> {
  const query = options?.scope ? `?scope=${encodeURIComponent(options.scope)}` : '';
  const res = await authFetch(`/api/agents${query}`);
  if (!res.ok) throw new Error(`Failed to fetch agent profiles: ${res.status}`);
  return res.json() as Promise<AgentProfile[]>;
}

export async function updateAgentProfile(
  username: string,
  data: { name?: string; signature?: string; avatar?: string },
): Promise<AgentProfile> {
  const res = await authFetch(`/api/agents/${username}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to update agent profile: ${res.status}`);
  return res.json() as Promise<AgentProfile>;
}

export async function fetchPersona(username: string): Promise<string> {
  const res = await authFetch(`/api/agents/${username}/persona`);
  if (!res.ok) throw new Error(`Failed to fetch persona: ${res.status}`);
  const data = await res.json() as { content: string };
  return data.content;
}

export async function updatePersona(username: string, content: string): Promise<void> {
  const res = await authFetch(`/api/agents/${username}/persona`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to update persona: ${res.status}`);
}

export async function fetchAgentMemory(username: string): Promise<string> {
  const res = await authFetch(`/api/agents/${username}/memory`);
  if (!res.ok) throw new Error(`Failed to fetch memory: ${res.status}`);
  const data = await res.json() as { content: string };
  return data.content;
}

export async function updateAgentMemory(username: string, content: string): Promise<void> {
  const res = await authFetch(`/api/agents/${username}/memory`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to update memory: ${res.status}`);
}

export async function uploadAgentAvatar(username: string, file: File | Blob | { uri: string; type: string; name: string }): Promise<string> {
  const formData = new FormData();
  // React Native FormData 需要 { uri, type, name } 对象而非 Blob
  formData.append('avatar', file as any);
  const res = await authFetch(`/api/agents/${username}/avatar`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    let msg = `上传失败 (${res.status})`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* ignore parse error */ }
    throw new Error(msg);
  }
  const data = await res.json() as { avatar: string };
  return data.avatar;
}

/** 判断 avatar 是 emoji 还是文件路径（个人 agent-avatars/ 与企业专家 org-agent-avatars/ 两种路径前缀） */
export function isEmojiAvatar(avatar?: string): boolean {
  if (!avatar) return true;
  return !avatar.startsWith('agent-avatars/') && !avatar.startsWith('org-agent-avatars/');
}

/** 获取 avatar 的显示 URL；企业专家的 username 约定为 `org-agent:<id>`（见 ChatTabContent displayAgentProfile） */
export function getAgentAvatarUrl(username: string, avatar?: string, serverUrl?: string, version?: number): string | null {
  if (!avatar || isEmojiAvatar(avatar)) return null;
  const base = serverUrl || '';
  const url = avatar.startsWith('org-agent-avatars/')
    ? `${base}/api/org-agents/avatar/${encodeURIComponent(username.replace(/^org-agent:/, ''))}`
    : `${base}/api/agents/avatar/${username}`;
  return version ? `${url}?v=${version}` : url;
}

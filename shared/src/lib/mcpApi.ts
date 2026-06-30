import { authFetch } from './authFetch';
import type { ManagedMcpServer, McpAdminServersResponse, McpDiagnosticResponse, McpTemplatesResponse, MyMcpResponse } from '../types/mcp';

type ApiErrorBody = { error?: string; details?: unknown };

function formatApiError(body: ApiErrorBody, fallback: string): string {
  const details = body.details ? `: ${JSON.stringify(body.details)}` : '';
  return `${body.error || fallback}${details}`;
}

async function jsonOrError<T>(res: Response, message: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(formatApiError(body, `${message}: ${res.status}`));
  }
  return res.json() as Promise<T>;
}

export async function fetchMcpTemplates(): Promise<McpTemplatesResponse> {
  return jsonOrError(await authFetch('/api/mcp/templates'), 'Failed to fetch MCP templates');
}

export async function fetchMyMcp(): Promise<MyMcpResponse> {
  return jsonOrError(await authFetch('/api/mcp/me'), 'Failed to fetch MCP settings');
}

export async function updateMyMcpSelections(enabledServers: string[]): Promise<void> {
  const res = await authFetch('/api/mcp/me/selections', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabledServers }),
  });
  if (!res.ok) throw new Error(`Failed to update MCP selections: ${res.status}`);
}

export async function bindMyMcpSecret(serverId: string, key: string, value: string): Promise<void> {
  const res = await authFetch(`/api/mcp/me/servers/${encodeURIComponent(serverId)}/secrets/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(formatApiError(body, `Failed to bind MCP secret: ${res.status}`));
  }
}

/**
 * admin 配置 tenant/global scope MCP secret。
 * scope 不由 client 传，由 server 的 secretRequirements[].scope 元数据决定：
 *   - scope === 'tenant' → 落到 tenant:<tenantId> ownerId；caller 必须能写该 server
 *   - scope === 'global' → 落到 global ownerId；caller 必须是平台 admin 且 server.tenantId === '*'
 * 错误码：400 入参非法 / 400 scope 与 server.tenantId 不兼容 / 403 跨组织或非平台 admin / 404 server 或 requirement 不存在
 */
export async function bindAdminMcpSecret(serverId: string, key: string, value: string): Promise<void> {
  const res = await authFetch(`/api/mcp/admin/servers/${encodeURIComponent(serverId)}/secrets/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(formatApiError(body, `Failed to bind admin MCP secret: ${res.status}`));
  }
}

export async function diagnoseMyMcp(): Promise<McpDiagnosticResponse> {
  return jsonOrError(await authFetch('/api/mcp/diagnose', { method: 'POST' }), 'Failed to diagnose MCP');
}

export async function fetchMcpAdminServers(): Promise<McpAdminServersResponse> {
  return jsonOrError(await authFetch('/api/mcp/admin/servers'), 'Failed to fetch MCP servers');
}

export async function upsertMcpServer(server: ManagedMcpServer): Promise<void> {
  const res = await authFetch(`/api/mcp/admin/servers/${encodeURIComponent(server.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(server),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(formatApiError(body, `Failed to save MCP server: ${res.status}`));
  }
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await authFetch(`/api/mcp/admin/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete MCP server: ${res.status}`);
}

export async function upsertMyMcpServer(server: ManagedMcpServer): Promise<void> {
  const res = await authFetch(`/api/mcp/me/servers/${encodeURIComponent(server.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(server),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(formatApiError(body, `Failed to save personal MCP server: ${res.status}`));
  }
}

export async function deleteMyMcpServer(id: string): Promise<void> {
  const res = await authFetch(`/api/mcp/me/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(formatApiError(body, `Failed to delete personal MCP server: ${res.status}`));
  }
}

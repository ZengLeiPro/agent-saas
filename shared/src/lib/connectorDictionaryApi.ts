/**
 * 平台管理「连接器映射」API 客户端。
 *
 * 词典决定工具行怎么把 `dws todo create ...` 还原成「钉钉 · 创建待办」，
 * 以及哪些调用配得上外部系统回执章。CLI 升级后运营在这里改，不必发版。
 */
import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';

export interface ConnectorActionVerb {
  /** 中文动作名，与模块名拼成一句话：`创建` + `待办` = 创建待办 */
  name: string;
  /** 是否写操作。只有写操作才会被当成「AI 动了外部系统」。 */
  write: boolean;
}

export interface ConnectorDictionaryEntry {
  binary: string;
  systemName: string;
  enabled: boolean;
  modules: Record<string, string>;
  actionVerbs: Record<string, ConnectorActionVerb>;
  excludePatterns: string[];
  urlWhitelist: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface ConnectorDictionaryResponse {
  entries: ConnectorDictionaryEntry[];
  /** 内置默认种子，供 UI 显示「与内置的差异」与恢复默认 */
  builtin: ConnectorDictionaryEntry[];
}

const API_BASE = '/api/admin/connector-dictionary';
const LABEL = '连接器映射';

export async function fetchConnectorDictionary(): Promise<ConnectorDictionaryResponse> {
  return parseJsonResponse<ConnectorDictionaryResponse>(await authFetch(API_BASE), LABEL);
}

export async function saveConnectorEntry(
  entry: ConnectorDictionaryEntry,
): Promise<ConnectorDictionaryResponse> {
  return parseJsonResponse<ConnectorDictionaryResponse>(
    await authFetch(`${API_BASE}/${encodeURIComponent(entry.binary)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }),
    LABEL,
  );
}

export async function deleteConnectorEntry(binary: string): Promise<ConnectorDictionaryResponse> {
  return parseJsonResponse<ConnectorDictionaryResponse>(
    await authFetch(`${API_BASE}/${encodeURIComponent(binary)}`, { method: 'DELETE' }),
    LABEL,
  );
}

export async function resetConnectorDictionary(): Promise<ConnectorDictionaryResponse> {
  return parseJsonResponse<ConnectorDictionaryResponse>(
    await authFetch(`${API_BASE}/reset`, { method: 'POST' }),
    LABEL,
  );
}

// ── 租户级覆盖（2026-08-04 任务 E）────────────────────────────────────────────
// 合并规则=租户条目按 binary 整条覆盖平台条目，不做字段级 merge。
// 响应把两层分开返回，合并展示由 UI 决定。

export interface OrgConnectorDictionaryResponse {
  tenantId: string;
  /** 平台级词典（组织侧只读基线） */
  platform: ConnectorDictionaryEntry[];
  /** 本租户的覆盖条目 */
  overrides: ConnectorDictionaryEntry[];
}

const ORG_API_BASE = '/api/org/connector-dictionary';

function orgQuery(tenantId?: string): string {
  return tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
}

export async function fetchOrgConnectorDictionary(
  tenantId?: string,
): Promise<OrgConnectorDictionaryResponse> {
  return parseJsonResponse<OrgConnectorDictionaryResponse>(
    await authFetch(`${ORG_API_BASE}${orgQuery(tenantId)}`),
    LABEL,
  );
}

export async function saveOrgConnectorEntry(
  entry: ConnectorDictionaryEntry,
  tenantId?: string,
): Promise<OrgConnectorDictionaryResponse> {
  return parseJsonResponse<OrgConnectorDictionaryResponse>(
    await authFetch(`${ORG_API_BASE}/${encodeURIComponent(entry.binary)}${orgQuery(tenantId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }),
    LABEL,
  );
}

export async function deleteOrgConnectorOverride(
  binary: string,
  tenantId?: string,
): Promise<OrgConnectorDictionaryResponse> {
  return parseJsonResponse<OrgConnectorDictionaryResponse>(
    await authFetch(`${ORG_API_BASE}/${encodeURIComponent(binary)}${orgQuery(tenantId)}`, {
      method: 'DELETE',
    }),
    LABEL,
  );
}

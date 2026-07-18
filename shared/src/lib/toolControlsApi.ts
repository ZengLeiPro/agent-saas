import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';

export type WebSearchProvider = 'brave' | 'volcengine' | 'tencent_wsa';

export interface WebToolsSearchConfig {
  enabled?: boolean;
  provider?: WebSearchProvider;
  endpoint?: string;
  apiKey?: string;
  apiKeyRef?: string;
  hasApiKey?: boolean;
  timeoutMs?: number;
  maxResults?: number;
}

export interface WebToolsFetchConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  allowedContentTypes?: string[];
  userAgent?: string;
}

export interface WebToolsEgressConfig {
  allowPrivateNetworks?: boolean;
  allowedHosts?: string[];
  blockedHosts?: string[];
}

export interface WebToolsConfig {
  enabled?: boolean;
  search?: WebToolsSearchConfig;
  fetch?: WebToolsFetchConfig;
  egress?: WebToolsEgressConfig;
}

export type ToolDescriptionOverrideMode = 'append' | 'replace';

export interface ToolDescriptionOverride {
  mode: ToolDescriptionOverrideMode;
  text: string;
}

export interface ToolControlConfig {
  enabled?: boolean;
  descriptionOverride?: ToolDescriptionOverride;
}

export interface ToolControlsConfig {
  enabled?: boolean;
  tools?: Record<string, ToolControlConfig>;
}

/**
 * Admin 治理页每个工具需要展示的完整字段。旧字段（id/name/category/label/enabled）
 * 保持向后兼容；新字段：
 *   - displayName / risk / approvalMode / auditCategory：技术契约，只读
 *   - description：md 原描述
 *   - effectiveDescription：合 override 后的最终 description（LLM 看到的）
 *   - inputSchema：JSON Schema（模型可见的 parameters）
 *   - descriptionOverride：当前配置里的 override（若有）
 *   - sourceModule：descriptor 定义所在文件（用于 admin 排查）
 */
export interface ToolCatalogItem {
  id: string;
  name: string;
  displayName: string;
  category: 'workspace' | 'memory' | 'skill' | 'meta' | 'session' | 'web' | 'media' | 'cron' | 'core' | string;
  label: string;
  enabled: boolean;
  description: string;
  effectiveDescription: string;
  inputSchema: Record<string, unknown>;
  risk: 'safe' | 'workspace_write' | 'dangerous';
  approvalMode: 'never' | 'web';
  auditCategory: string;
  descriptionOverride?: ToolDescriptionOverride;
  sourceModule?: string;
}

export interface ToolControlsAdminResponse {
  toolControls: ToolControlsConfig | null;
  tools: ToolCatalogItem[];
  webTools: WebToolsConfig | null;
  effectiveWebTools: string[];
}

export interface UpdateToolControlsRequest {
  toolControls: ToolControlsConfig | null;
  webTools: WebToolsConfig | null;
}

/**
 * 单工具粒度 PUT 请求体。字段皆可选：
 *   - enabled 存在 → 覆盖当前工具的 enabled
 *   - descriptionOverride === null → 清除现有 override
 *   - descriptionOverride === {mode,text} → 覆盖
 */
export interface UpdateSingleToolRequest {
  enabled?: boolean;
  descriptionOverride?: ToolDescriptionOverride | null;
}

const API_BASE = '/api/admin/tool-controls';

export async function fetchToolControlsConfig(): Promise<ToolControlsAdminResponse> {
  return parseJsonResponse<ToolControlsAdminResponse>(
    await authFetch(API_BASE),
    '工具开关',
  );
}

export async function updateToolControlsConfig(payload: UpdateToolControlsRequest): Promise<ToolControlsAdminResponse> {
  return parseJsonResponse<ToolControlsAdminResponse>(
    await authFetch(API_BASE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    '工具开关',
  );
}

export async function updateSingleTool(
  toolId: string,
  payload: UpdateSingleToolRequest,
): Promise<ToolControlsAdminResponse> {
  return parseJsonResponse<ToolControlsAdminResponse>(
    await authFetch(`${API_BASE}/${encodeURIComponent(toolId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    '工具开关',
  );
}

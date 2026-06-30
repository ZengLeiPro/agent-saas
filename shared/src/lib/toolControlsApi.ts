import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';

export type WebSearchProvider = 'brave' | 'volcengine';

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

export interface ToolControlConfig {
  enabled?: boolean;
}

export interface ToolControlsConfig {
  enabled?: boolean;
  tools?: Record<string, ToolControlConfig>;
}

export interface ToolCatalogItem {
  id: string;
  name: string;
  category: 'workspace' | 'memory' | 'skill' | 'meta' | 'session' | 'web' | string;
  label: string;
  enabled: boolean;
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

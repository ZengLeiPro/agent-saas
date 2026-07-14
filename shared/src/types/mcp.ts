export type McpTransport = 'stdio' | 'http' | 'streamable-http';
export type McpRiskLevel = 'read_only' | 'workspace_write' | 'external_write' | 'credentialed_external_write';
export type McpSecretScope = 'user' | 'tenant' | 'global';
export type McpSecretTarget = 'env' | 'header';

export interface McpSecretRequirement {
  key: string;
  label: string;
  target: McpSecretTarget;
  name: string;
  scope: McpSecretScope;
  required?: boolean;
  prefix?: string;
  instructions?: string;
}

export interface McpSecretStatus extends McpSecretRequirement {
  configured: boolean;
}

export interface McpOAuthSummary {
  provider: 'github' | 'notion' | 'google-workspace' | 'generic';
  beta: boolean;
  platformConfigured: boolean;
  status: 'disconnected' | 'pending' | 'connected' | 'error';
  connectedAt?: string;
  updatedAt?: string;
  lastError?: string;
}

export interface McpServerSummary {
  id: string;
  name: string;
  description?: string;
  enabledByDefault: boolean;
  enabled: boolean;
  transport: McpTransport;
  riskLevel?: McpRiskLevel;
  secretRequirements?: McpSecretStatus[];
  createdFromTemplateId?: string;
  createdFromTemplateVersion?: number;
  ownerUsername?: string;
  personal?: boolean;
  config?: Record<string, unknown>;
  oauth?: McpOAuthSummary;
}

export interface McpOAuthStartResponse {
  status: 'pending' | 'connected';
  authorizationUrl?: string;
}

export interface MyMcpResponse {
  configVersion: number;
  servers: McpServerSummary[];
}

/**
 * 组织哨兵：tenantId = '*' 表示「全局 server」，可被所有组织用户启用，
 * 仅平台 admin 可创建/修改/删除。组织 admin 配的 server 必须 tenantId === own。
 */
export const GLOBAL_TENANT_ID = '*';

export interface ManagedMcpServer {
  id: string;
  name: string;
  description?: string;
  enabledByDefault?: boolean;
  riskLevel?: McpRiskLevel;
  secretRequirements?: McpSecretRequirement[];
  createdFromTemplateId?: string;
  createdFromTemplateVersion?: number;
  config: Record<string, unknown>;
  /**
   * 组织归属。wire format：客户端可不传，由后端按 caller 身份决定：
   *   - 平台 admin 不传 → 默认 own；显式 '*' = 全局 server；显式具体 slug = 跨组织写
   *   - 组织 admin：强制 own（即使传了 '*' 或其他组织也被后端 403）
   * 服务端返回时一定带值（store 内部模型必填）。
   */
  tenantId?: string;
  /** 普通用户自助添加的私有 MCP server；仅 owner 本人可见、可写。 */
  ownerUsername?: string;
}

export interface McpTemplate {
  id: string;
  templateVersion: number;
  name: string;
  description: string;
  riskLevel: McpRiskLevel;
  recommendedDefault: boolean;
  server: ManagedMcpServer;
}

export interface McpTemplatesResponse {
  templates: McpTemplate[];
}

export interface McpAdminServersResponse {
  configVersion: number;
  servers: ManagedMcpServer[];
}

export interface McpDiagnosticTool {
  serverName: string;
  toolName: string;
  description: string;
}

export interface McpDiagnosticResponse {
  ok: boolean;
  toolCount: number;
  tools: McpDiagnosticTool[];
  workspaceRoot?: string;
  error?: string;
}

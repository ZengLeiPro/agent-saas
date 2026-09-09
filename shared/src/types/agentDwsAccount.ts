export type AgentDwsAccountStatus =
  | "draft"
  | "authorizing"
  | "active"
  | "paused"
  | "error";

export type AgentDwsRuntimeStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "error";

export type AgentDwsEventKind = "at_me" | "all_direct";
export type AgentDwsContextPolicyMode = "none" | "selected" | "all";

export type AgentDwsReadinessSeverity = "ready" | "blocking" | "unknown";
export type AgentDwsReadinessStatus = "ready" | "blocked" | "unknown";
export type AgentDwsReadinessCode =
  | "account.authorization"
  | "stream.ready"
  | "stream.lease"
  | "agent.enabled"
  | "agent.dispatcher"
  | "runtime.v2"
  | "binding.active"
  | "binding.live_deny"
  | "context.dependencies"
  | "worker.capability"
  | "completion.delivery";
export type AgentDwsReadinessFixTarget =
  | "account_authorization"
  | "stream_runtime"
  | "agent_settings"
  | "runtime_compatibility"
  | "group_binding"
  | "context_settings"
  | "capability_settings"
  | "delivery_settings";

export interface AgentDwsReadinessCheck {
  code: AgentDwsReadinessCode;
  severity: AgentDwsReadinessSeverity;
  message: string;
  fixTarget: AgentDwsReadinessFixTarget;
}

export interface AgentDwsReadiness {
  status: AgentDwsReadinessStatus;
  checks: AgentDwsReadinessCheck[];
}

export type AgentDwsConfigPreviewLayerSource = "published" | "channel" | "conversation";
export type AgentDwsConfigPreviewWarningCode =
  | "agent.unavailable"
  | "agent.not_dispatcher"
  | "channel.context_unavailable"
  | "conversation.inactive"
  | "conversation.live_deny"
  | "conversation.skills_narrowed"
  | "conversation.tools_narrowed"
  | "conversation.sources_narrowed"
  | "conversation.skills_outside_published"
  | "conversation.tools_outside_channel"
  | "conversation.sources_outside_channel"
  | "conversation.full_snapshot";

export interface AgentDwsConfigPreviewLayer {
  source: AgentDwsConfigPreviewLayerSource;
  label: "当前发布值" | "渠道上限" | "会话已保存值";
  available: boolean;
  summaries: string[];
}

export interface AgentDwsConfigPreviewEffective {
  label: "当前可执行最终值";
  status: "available" | "unavailable";
  unavailableReasons: string[];
  instructionsConfigured: boolean;
  contextEnabled: boolean;
  frontdesk: {
    status: "available" | "unavailable";
    skillCount: number;
    toolCount: number;
    sourceCount: number;
  };
  worker: {
    status: "task_compile_required" | "unavailable";
    skillCount: number;
    sourceCount: number;
    dwsResourceCount: number;
  };
  completion: "回复原会话" | "完成后静默";
  taskVisibility: "群内可见" | "仅发起人可见";
}

export interface AgentDwsConfigPreviewWarning {
  code: AgentDwsConfigPreviewWarningCode;
  severity: "warning" | "info";
  message: string;
}

export interface AgentDwsConfigPreview {
  version: 1;
  layers: AgentDwsConfigPreviewLayer[];
  effective: AgentDwsConfigPreviewEffective;
  warnings: AgentDwsConfigPreviewWarning[];
}

export interface AgentDwsContextPolicySelection {
  mode: AgentDwsContextPolicyMode;
  conversationIds: string[];
}

export interface AgentDwsContextPolicy {
  historical: AgentDwsContextPolicySelection & { lookbackDays: number };
  realtime: AgentDwsContextPolicySelection;
  wiki: { enabled: boolean };
  minutes: { enabled: boolean; lookbackDays: number };
  realtimeEffectiveAt?: { all?: string; conversations?: Record<string, string> };
  effectiveAt?: string;
}

export interface AgentDwsAccount {
  accountId: string;
  tenantId: string;
  agentId: string;
  displayName: string;
  loginIdMasked: string;
  corpId: string | null;
  corpName: string | null;
  dingtalkUserId: string | null;
  dingtalkUserName: string | null;
  profileId: string | null;
  status: AgentDwsAccountStatus;
  runtimeStatus: AgentDwsRuntimeStatus;
  eventKinds: AgentDwsEventKind[];
  contextPolicy: AgentDwsContextPolicy;
  lastEventAt: string | null;
  lastError: string | null;
  revision: number;
  identityUpdatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  readiness?: AgentDwsReadiness;
}

export interface AgentDwsAuthSession {
  sessionId: string;
  status: "starting" | "awaiting_user" | "connected" | "failed" | "expired";
  authorizationUrl: string | null;
  userCode: string | null;
  expiresAt: string;
  message: string;
}

export interface CreateAgentDwsAccountInput {
  tenantId?: string;
  agentId: string;
  displayName: string;
  loginId: string;
  corpId?: string;
  eventKinds?: AgentDwsEventKind[];
}

export interface UpdateAgentDwsAccountInput {
  expectedRevision: number;
  enabled: boolean;
}

export interface UpdateAgentDwsContextPolicyInput extends AgentDwsContextPolicy {
  expectedRevision: number;
}

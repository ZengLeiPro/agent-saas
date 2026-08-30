/** M30-03: pure, platform-independent auth/connection degraded-mode contract, reducer and presenter. */
export type CapabilityMode = 'normal' | 'degraded' | 'blocked';
export type CapabilityChannel = 'web' | 'mobile';
export type CapabilityKind =
  | 'auth.password' | 'auth.sso.browser' | 'connection.oauth.native'
  | 'connection.oauth.browser' | 'connection.refresh' | 'messaging.send'
  | 'shell.local.readonly';
export type CapabilityReasonCode =
  | 'none' | 'provider_not_configured' | 'callback_domain_missing' | 'sso_unavailable'
  | 'credential_expired' | 'network_offline' | 'server_degraded'
  | 'tenant_policy_disabled' | 'unknown_server_capability' | 'user_cancelled';
export type CapabilityAction =
  | 'continue' | 'use_system_browser_sso' | 'reauthenticate' | 'contact_admin'
  | 'retry_later' | 'open_readonly_local_shell';

export interface AuthConnectionCapabilityStatus {
  schemaVersion: 1;
  mode: CapabilityMode;
  reasonCode: CapabilityReasonCode;
  affectedCapabilities: CapabilityKind[];
  allowedActions: CapabilityAction[];
  recoveryActions: CapabilityAction[];
  observedAt: string;
  correlationId: string;
  authoritative: boolean;
  subject: { userId: string; tenantId: string; provider: string; channel: CapabilityChannel };
  requiresServerRevalidation: boolean;
}

export interface CapabilityObservation {
  userId: string;
  tenantId: string;
  provider: string;
  channel: CapabilityChannel;
  correlationId: string;
  observedAt: string;
  providerConfigured: boolean;
  callbackDomainConfigured: boolean;
  ssoAvailable: boolean;
  credential: 'valid' | 'expired' | 'missing' | 'not_applicable';
  network: 'online' | 'offline';
  server: 'healthy' | 'degraded';
  tenantAllowed: boolean;
  operation: 'auth' | 'connection';
}

const CONNECTION_BLOCKED: CapabilityKind[] = ['connection.oauth.native', 'connection.oauth.browser', 'connection.refresh', 'messaging.send'];
const LOCAL_ONLY: CapabilityAction[] = ['open_readonly_local_shell', 'retry_later'];

function status(input: CapabilityObservation, patch: Omit<AuthConnectionCapabilityStatus, 'schemaVersion' | 'observedAt' | 'correlationId' | 'subject' | 'authoritative'>): AuthConnectionCapabilityStatus {
  return {
    schemaVersion: 1,
    observedAt: input.observedAt,
    correlationId: input.correlationId,
    authoritative: true,
    subject: { userId: input.userId, tenantId: input.tenantId, provider: input.provider, channel: input.channel },
    ...patch,
  };
}

/** Ordered fail-closed evaluation. Tenant policy always wins over fallback. */
export function evaluateCapability(input: CapabilityObservation): AuthConnectionCapabilityStatus {
  if (!input.tenantAllowed) return status(input, { mode: 'blocked', reasonCode: 'tenant_policy_disabled', affectedCapabilities: CONNECTION_BLOCKED, allowedActions: ['contact_admin'], recoveryActions: ['contact_admin'], requiresServerRevalidation: true });
  if (input.server === 'degraded') return status(input, { mode: 'degraded', reasonCode: 'server_degraded', affectedCapabilities: CONNECTION_BLOCKED, allowedActions: LOCAL_ONLY, recoveryActions: ['retry_later'], requiresServerRevalidation: true });
  if (input.network === 'offline') return status(input, { mode: 'degraded', reasonCode: 'network_offline', affectedCapabilities: CONNECTION_BLOCKED, allowedActions: LOCAL_ONLY, recoveryActions: ['retry_later'], requiresServerRevalidation: true });
  if (!input.providerConfigured) return status(input, { mode: 'blocked', reasonCode: 'provider_not_configured', affectedCapabilities: input.operation === 'auth' ? ['auth.sso.browser'] : CONNECTION_BLOCKED, allowedActions: ['contact_admin'], recoveryActions: ['contact_admin'], requiresServerRevalidation: true });
  if (input.operation === 'auth' && !input.ssoAvailable) return status(input, { mode: 'blocked', reasonCode: 'sso_unavailable', affectedCapabilities: ['auth.sso.browser'], allowedActions: ['retry_later', 'contact_admin'], recoveryActions: ['retry_later', 'contact_admin'], requiresServerRevalidation: true });
  if (input.operation === 'connection' && input.channel === 'mobile' && !input.callbackDomainConfigured) return status(input, { mode: 'degraded', reasonCode: 'callback_domain_missing', affectedCapabilities: ['connection.oauth.native'], allowedActions: ['use_system_browser_sso', 'contact_admin'], recoveryActions: ['contact_admin'], requiresServerRevalidation: true });
  if (input.operation === 'connection' && input.credential === 'expired') return status(input, { mode: 'degraded', reasonCode: 'credential_expired', affectedCapabilities: ['connection.refresh', 'messaging.send'], allowedActions: ['reauthenticate', 'open_readonly_local_shell'], recoveryActions: ['reauthenticate'], requiresServerRevalidation: true });
  return status(input, { mode: 'normal', reasonCode: 'none', affectedCapabilities: [], allowedActions: ['continue'], recoveryActions: [], requiresServerRevalidation: false });
}

export type CapabilityEvent =
  | { type: 'hydrate_authoritative'; status: AuthConnectionCapabilityStatus }
  | { type: 'client_offline'; observedAt: string; correlationId: string }
  | { type: 'user_cancelled'; observedAt: string; correlationId: string }
  | { type: 'recovery_requested' };

/** Client state machine: cached degraded state is display-only; normal can only be hydrated from server. */
export function reduceCapabilityStatus(current: AuthConnectionCapabilityStatus | null, event: CapabilityEvent): AuthConnectionCapabilityStatus | null {
  if (event.type === 'hydrate_authoritative') return event.status.authoritative ? event.status : current;
  if (!current) return null;
  if (event.type === 'recovery_requested') return { ...current, mode: 'blocked', allowedActions: [], requiresServerRevalidation: true };
  if (event.type === 'client_offline') return { ...current, mode: 'degraded', reasonCode: 'network_offline', affectedCapabilities: CONNECTION_BLOCKED, allowedActions: LOCAL_ONLY, recoveryActions: ['retry_later'], observedAt: event.observedAt, correlationId: event.correlationId, authoritative: false, requiresServerRevalidation: true };
  return { ...current, mode: 'blocked', reasonCode: 'user_cancelled', affectedCapabilities: CONNECTION_BLOCKED, allowedActions: ['retry_later'], recoveryActions: ['retry_later'], observedAt: event.observedAt, correlationId: event.correlationId, authoritative: false, requiresServerRevalidation: true };
}

/** N-1 server (404/invalid contract): never infer normal. Browser flow remains explicit and user-initiated. */
export function unknownServerCapability(input: { userId: string; tenantId: string; provider: string; channel: CapabilityChannel; observedAt: string; correlationId: string; explicitBrowserFlow?: boolean }): AuthConnectionCapabilityStatus {
  return {
    schemaVersion: 1, mode: 'blocked', reasonCode: 'unknown_server_capability',
    affectedCapabilities: CONNECTION_BLOCKED,
    allowedActions: input.explicitBrowserFlow ? ['use_system_browser_sso'] : [],
    recoveryActions: ['retry_later'], observedAt: input.observedAt, correlationId: input.correlationId,
    authoritative: false, subject: { userId: input.userId, tenantId: input.tenantId, provider: input.provider, channel: input.channel },
    requiresServerRevalidation: true,
  };
}

export interface CapabilityPresentation {
  title: string;
  detail: string;
  actions: Array<{ action: CapabilityAction; label: string; leavesApp: boolean }>;
  blocksSensitiveOperations: boolean;
}

const ACTION_LABELS: Record<CapabilityAction, string> = {
  continue: '继续', use_system_browser_sso: '在系统浏览器中继续', reauthenticate: '重新认证',
  contact_admin: '联系管理员配置', retry_later: '稍后重试', open_readonly_local_shell: '打开只读本地壳层',
};

export function presentCapability(state: AuthConnectionCapabilityStatus): CapabilityPresentation {
  const detail = state.mode === 'normal' ? '服务端能力与凭据已验证。'
    : state.reasonCode === 'network_offline' ? '当前离线；仅允许查看本地只读内容。'
    : state.reasonCode === 'credential_expired' ? '凭据已过期；发送、连接和敏感刷新已阻止。'
    : state.reasonCode === 'tenant_policy_disabled' ? '组织策略已禁用此能力，不能绕过。'
    : state.reasonCode === 'unknown_server_capability' ? '服务器版本不提供权威能力合同，已安全阻止。'
    : '此能力当前不可用；请按安全恢复动作处理。';
  return {
    title: state.mode === 'normal' ? '能力可用' : state.mode === 'degraded' ? '受限模式' : '能力已阻止',
    detail,
    actions: state.allowedActions.map(action => ({ action, label: ACTION_LABELS[action], leavesApp: action === 'use_system_browser_sso' })),
    blocksSensitiveOperations: !isSensitiveCapabilityAllowed(state),
  };
}

export function isSensitiveCapabilityAllowed(state: AuthConnectionCapabilityStatus): boolean {
  return state.authoritative && state.mode === 'normal' && !state.requiresServerRevalidation;
}

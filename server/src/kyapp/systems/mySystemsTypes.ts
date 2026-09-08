export const MY_SYSTEM_PAGE_STATUSES = ['not_configured', 'available', 'unavailable'] as const;
export type MySystemPageStatus = (typeof MY_SYSTEM_PAGE_STATUSES)[number];

export const MY_SYSTEM_AGENT_STATUSES = [
  'not_configured',
  'waiting_service',
  'waiting_assignment',
  'waiting_personal_authorization',
  'ready',
  'degraded',
  'disabled',
] as const;
export type MySystemAgentStatus = (typeof MY_SYSTEM_AGENT_STATUSES)[number];

export const MY_SYSTEM_PERSONAL_AUTHORIZATION_STATUSES = [
  'not_required',
  'pending',
  'connected',
  'expired',
  'insufficient_scope',
] as const;
export type MySystemPersonalAuthorizationStatus =
  (typeof MY_SYSTEM_PERSONAL_AUTHORIZATION_STATUSES)[number];

export const MY_SYSTEM_NEXT_ACTIONS = [
  'none',
  'continue_onboarding',
  'edit_assignment',
  'authorize',
  'retry',
] as const;
export type MySystemNextAction = (typeof MY_SYSTEM_NEXT_ACTIONS)[number];

export const KY_APP_MINE_STATES = [
  'enabled',
  'disabled',
  'unavailable',
  'maintenance',
  'needs_reregistration',
] as const;
export type KyAppMineState = (typeof KY_APP_MINE_STATES)[number];

export interface MyBusinessSystem {
  installationId: string;
  systemId: string;
  name: string;
  icon: string | null;
  origin: string;
  state: KyAppMineState;
  externalLinkHosts: string[];
  pageStatus: MySystemPageStatus;
  agentStatus: MySystemAgentStatus;
  personalAuthorizationStatus: MySystemPersonalAuthorizationStatus;
  canOpenPage: boolean;
  canUseAgent: boolean;
  reasonCode: string | null;
  nextAction: MySystemNextAction;
  message: string;
}

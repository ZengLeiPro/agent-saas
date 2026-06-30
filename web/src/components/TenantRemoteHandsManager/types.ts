export type TenantRemoteHandRolloutMode = "disabled" | "drain" | "allowlist" | "tenant" | "all";
export type NetworkPolicyMode = "isolated" | "public-egress" | "private-egress";

export interface NetworkPolicyConfig {
  mode: NetworkPolicyMode;
  denyPrivateNetworks?: boolean;
  allowCidrs?: string[];
  allowDomains?: string[];
  denyCidrs?: string[];
}

export type TenantRemoteHandRollout = {
  mode: TenantRemoteHandRolloutMode;
  userIds?: string[];
  usernames?: string[];
  tenantIds?: string[];
};

export interface TenantRemoteHandConfig {
  id: string;
  description?: string;
  users?: string[];
  tenantIds?: string[];
  rollout?: TenantRemoteHandRollout;
  baseUrl: string;
  authTokenRef?: string;
  authTokenConfigured?: boolean;
  invokeTimeoutMs?: number;
  networkPolicy?: NetworkPolicyConfig;
  recipe?: unknown;
}

export interface TenantRemoteHandsConfig {
  hands: TenantRemoteHandConfig[];
}

export interface TenantRemoteHandsResponse {
  tenantRemoteHands: TenantRemoteHandsConfig;
  error?: string;
}

export interface TenantRemoteHandHealthResponse {
  id: string;
  status: "ok" | "unhealthy";
  detail?: string;
  metadata?: unknown;
  error?: string;
}

export type HealthState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; metadata?: unknown }
  | { status: "unhealthy"; detail?: string; metadata?: unknown };

export type CredentialMode = "preserve" | "inline" | "ref";
export type RolloutEditorMode = "legacy" | "explicit";

export interface EditableTenantRemoteHand {
  clientKey: string;
  originalId: string | null;
  isNew: boolean;
  id: string;
  description: string;
  baseUrl: string;
  invokeTimeoutMsText: string;
  recipe?: unknown;
  legacyUsersText: string;
  legacyTenantIdsText: string;
  rolloutEditorMode: RolloutEditorMode;
  rolloutMode: TenantRemoteHandRolloutMode;
  rolloutUserIds: string[];
  rolloutUsernamesText: string;
  rolloutTenantIds: string[];
  networkPolicyMode: NetworkPolicyMode;
  networkDenyPrivateNetworks: boolean;
  networkAllowCidrsText: string;
  networkAllowDomainsText: string;
  networkDenyCidrsText: string;
  credentialMode: CredentialMode;
  authTokenInput: string;
  authTokenRef: string;
  authTokenConfigured: boolean;
}

export interface TenantRemoteHandUpdate {
  id: string;
  description?: string;
  users?: string[];
  tenantIds?: string[];
  rollout?: TenantRemoteHandRollout;
  baseUrl: string;
  authToken?: string;
  authTokenRef?: string;
  invokeTimeoutMs?: number;
  networkPolicy?: NetworkPolicyConfig;
  recipe?: unknown;
}

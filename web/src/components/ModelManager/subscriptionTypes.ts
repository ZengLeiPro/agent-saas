import type { AdminConfigResponseMetadata } from '@/hooks/useAdminConfigWritePolicy';
export type SubscriptionRuntimeStatus = {
  requestWindow: {
    limit: number;
    sampleCount: number;
    eligibleRequestCount: number;
    cacheHitRequestCount: number;
    eligibleInputTokens: number;
    cachedInputTokens: number;
    cacheHitRequestRate?: number;
    cachedInputTokenRate?: number;
  };
  wireWindow?: {
    limit: number;
    sampleCount: number;
    websocketRequestCount: number;
    relayRequestCount: number;
    fallbackFullRequestCount: number;
    httpFallbackRequestCount: number;
    logicalRequestBodyBytes: number;
    wireRequestBodyBytes: number;
    savedRequestBodyBytes: number;
    savedRequestBodyRate?: number;
    lastFallbackReason?: string;
  };
  lastRequestAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastModel?: string;
  oauth: {
    lastRefreshAt?: string;
    lastRefreshGeneration?: number;
    lastRefreshErrorAt?: string;
    lastRefreshError?: string;
  };
};

export type SubscriptionCredentialState = {
  id?: string;
  priority?: number;
  configured: boolean;
  connected: boolean;
  accountBindingHash?: string;
  accountIdHint?: string;
  email?: string;
  expiresAt?: string;
  accessTokenExpired?: boolean;
  generation?: number;
  availability?: 'available' | 'quota_cooldown' | 'auth_unavailable';
  cooldownUntil?: string;
  lastFailureCode?: string;
  error?: string;
};

export type GrokSubscriptionState = AdminConfigResponseMetadata & {
  config: {
    enabled: boolean;
    quotaCooldownMinutes: number;
    endpoint: string;
    oauthClientId: string;
    credentialCount: number;
  };
  credentials: SubscriptionCredentialState[];
  runtime?: SubscriptionRuntimeStatus;
  warning?: string;
};
export type GrokDeviceSession = {
  sessionId: string;
  status: 'pending' | 'authorized_pending_publication' | 'applied' | 'expired' | 'denied' | 'error';
  expiresAt: string;
  intervalMs?: number;
  intervalSeconds?: number;
  userCode?: string;
  verificationUri?: string;
  error?: string;
};

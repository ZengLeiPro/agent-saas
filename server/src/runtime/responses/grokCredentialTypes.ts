import type { GrokOAuthTokens } from './grokOAuthClient.js';
export const GROK_SECRET_KIND = 'grok_subscription_oauth';
export interface GrokSubscriptionRuntimeConfig {
  enabled?: boolean;
  credentialRef?: string;
  credentialRefs?: string[];
  quotaCooldownMinutes?: number;
  endpoint?: string;
  oauthClientId?: string;
}
export interface GrokTokenBundle extends GrokOAuthTokens {
  generation: number;
  credentialRef?: string;
}
export class GrokCredentialError extends Error {
  constructor(
    readonly code: string,
    readonly credentialGeneration = 0,
  ) {
    super(`Grok ${code}`);
    this.name = 'GrokCredentialError';
  }
}
export interface GrokCredentialStatus {
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
}

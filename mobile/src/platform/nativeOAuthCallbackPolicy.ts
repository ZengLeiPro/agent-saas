import Constants from 'expo-constants';
import { normalizeCallbackBase } from '@agent/shared';

type CallbackConfig = { allowlist?: unknown };

/** The generated Expo config is the only runtime callback trust authority. */
export function getNativeOAuthCallbackAllowlist(): readonly string[] {
  const extra = Constants.expoConfig?.extra as { oauthCallback?: CallbackConfig } | undefined;
  const values = extra?.oauthCallback?.allowlist;
  if (!Array.isArray(values)) return [];
  const normalized = values
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeCallbackBase)
    .filter((value): value is string => value !== null);
  return [...new Set(normalized)];
}

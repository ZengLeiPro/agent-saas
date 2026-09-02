import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IPlatformConfig, TrustedUrlKind } from '@agent/shared';
import {
  assertTrustedServiceUrl,
  decideServiceOriginChange,
  resolveMobileServicePolicy,
  TrustedServiceConfigurationError,
  type MobileServiceBuildInput,
  type MobileServicePolicy,
  type ServiceOriginChangeDecision,
} from './trustedServiceOrigin';

const SERVER_URL_KEY = 'agentChat.serverUrl';
const LEGACY_LAN_URL_KEY = 'agentChat.lanUrl';
const TRUSTED_ORIGIN_BINDING_KEY = 'agentChat.trustedServiceOrigin';
const SERVICE_PROBE_TIMEOUT_MS = 10_000;

function readBuildInput(): MobileServiceBuildInput {
  return {
    dev: typeof __DEV__ !== 'undefined' && __DEV__,
    profileEnv: process.env.EXPO_PUBLIC_V1_PROFILE,
    apiOrigin: process.env.EXPO_PUBLIC_MOBILE_API_ORIGIN,
    apiAllowlist: process.env.EXPO_PUBLIC_MOBILE_API_ALLOWLIST,
    wsAllowlist: process.env.EXPO_PUBLIC_MOBILE_WS_ALLOWLIST,
  };
}

let servicePolicy = resolveMobileServicePolicy(readBuildInput());
const authEnabledByBaseUrl = new Map<string, Promise<boolean>>();

function clonePolicy(policy: MobileServicePolicy): MobileServicePolicy {
  return {
    ...policy,
    apiAllowlist: [...policy.apiAllowlist],
    wsAllowlist: [...policy.wsAllowlist],
    issue: policy.issue ? { ...policy.issue } : null,
  };
}

function requireReadyPolicy(): MobileServicePolicy {
  if (!servicePolicy.ready || !servicePolicy.apiOrigin || !servicePolicy.wsUrl) {
    throw new TrustedServiceConfigurationError(
      servicePolicy.issue?.code ?? 'CONFIG_NOT_READY',
      servicePolicy.issue?.message ?? '可信服务配置尚未就绪。',
    );
  }
  return servicePolicy;
}

function requireResolvedCandidate(policy: MobileServicePolicy): MobileServicePolicy {
  if (!policy.ready || !policy.apiOrigin || !policy.wsUrl) {
    throw new TrustedServiceConfigurationError(
      policy.issue?.code ?? 'CONFIG_NOT_READY',
      policy.issue?.message ?? '可信服务配置尚未就绪。',
    );
  }
  return policy;
}

export type ServiceOriginInvalidator = () => Promise<void>;

export interface SetServerUrlResult extends ServiceOriginChangeDecision {
  policy: MobileServicePolicy;
}

/** Current immutable diagnostic snapshot, safe to render before login. */
export function getServiceConfigSnapshot(): MobileServicePolicy {
  return clonePolicy(servicePolicy);
}

/**
 * Load the selected service origin. Production ignores and removes every
 * user-saved override. Invalid, changed, or legacy-unbound configuration
 * invalidates the account before any origin can become active.
 */
export async function loadServerUrl(
  invalidateSession: ServiceOriginInvalidator,
): Promise<MobileServicePolicy> {
  const input = readBuildInput();
  const saved = await AsyncStorage.getItem(SERVER_URL_KEY);
  // LAN auto-routing was removed by M10-01; delete any legacy probe target so
  // it cannot silently return in a later code path.
  await AsyncStorage.removeItem(LEGACY_LAN_URL_KEY);
  let next = resolveMobileServicePolicy(input, saved);

  if (next.profile === 'production' && saved) {
    await AsyncStorage.removeItem(SERVER_URL_KEY);
  } else if (saved && !next.ready) {
    // A stale development/preview override must not brick a build whose
    // build-time default is valid. Drop it and still force re-auth below.
    const buildDefault = resolveMobileServicePolicy(input);
    if (buildDefault.ready) {
      next = buildDefault;
      await AsyncStorage.removeItem(SERVER_URL_KEY);
    }
  }

  const previousBinding = await AsyncStorage.getItem(TRUSTED_ORIGIN_BINDING_KEY);
  if (!next.ready || !next.apiOrigin) {
    // Invalid configuration invalidates auth even when a legacy install has no
    // binding marker; retaining a token is unnecessary and risks later reuse.
    await invalidateSession();
    if (previousBinding) {
      await AsyncStorage.removeItem(TRUSTED_ORIGIN_BINDING_KEY);
    }
  } else if (previousBinding !== next.apiOrigin) {
    // Missing binding includes upgrades from the legacy arbitrary-origin code.
    await invalidateSession();
    await AsyncStorage.setItem(TRUSTED_ORIGIN_BINDING_KEY, next.apiOrigin);
  }

  servicePolicy = next;
  authEnabledByBaseUrl.clear();
  return clonePolicy(servicePolicy);
}

/**
 * Change origin only inside a development/preview build allowlist.
 * Security ordering is intentional: disconnect/clear auth first, persist the
 * new device selection second, expose it in memory last. Any partial failure
 * therefore leaves credentials unusable rather than sending them cross-origin.
 */
export async function setServerUrl(
  rawUrl: string,
  invalidateSession: ServiceOriginInvalidator,
): Promise<SetServerUrlResult> {
  if (!servicePolicy.editable) {
    throw new TrustedServiceConfigurationError(
      'ORIGIN_EDIT_DISABLED',
      '生产版本的服务地址由构建配置锁定，不能在应用内修改。',
    );
  }

  const candidate = requireResolvedCandidate(
    resolveMobileServicePolicy(readBuildInput(), rawUrl.trim()),
  );
  const decision = decideServiceOriginChange(
    servicePolicy.apiOrigin,
    candidate.apiOrigin!,
  );

  if (decision.requiresReauthentication) {
    await invalidateSession();
    await AsyncStorage.setItem(SERVER_URL_KEY, candidate.apiOrigin!);
    await AsyncStorage.setItem(
      TRUSTED_ORIGIN_BINDING_KEY,
      candidate.apiOrigin!,
    );
    servicePolicy = candidate;
    authEnabledByBaseUrl.clear();
  }

  return { ...decision, policy: clonePolicy(servicePolicy) };
}

/** Get the selected, policy-validated API origin. */
export function getServerUrl(): string {
  return requireReadyPolicy().apiOrigin!;
}

function isAuthEnabled(): Promise<boolean> {
  const baseUrl = getServerUrl();
  const url = `${baseUrl}/api/auth/me`;
  assertTrustedServiceUrl(servicePolicy, url, 'http');

  let result = authEnabledByBaseUrl.get(baseUrl);
  if (!result) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SERVICE_PROBE_TIMEOUT_MS,
    );
    const request: Promise<boolean> = fetch(url, { signal: controller.signal })
      .then((response) => {
        const enabled = response.status !== 404;
        if (!enabled && authEnabledByBaseUrl.get(baseUrl) === request) {
          authEnabledByBaseUrl.delete(baseUrl);
        }
        return enabled;
      })
      .catch(() => {
        if (authEnabledByBaseUrl.get(baseUrl) === request) {
          authEnabledByBaseUrl.delete(baseUrl);
        }
        return true;
      })
      .finally(() => clearTimeout(timeout));
    authEnabledByBaseUrl.set(baseUrl, request);
    result = request;
  }
  return result;
}

export const mobileConfig: IPlatformConfig = {
  platform: 'mobile',
  getBaseUrl(): string {
    return getServerUrl();
  },
  getWsUrl(): string {
    const wsUrl = requireReadyPolicy().wsUrl!;
    assertTrustedServiceUrl(servicePolicy, wsUrl, 'websocket');
    return wsUrl;
  },
  assertTrustedUrl(url: string, kind: TrustedUrlKind): void {
    assertTrustedServiceUrl(servicePolicy, url, kind);
  },
  isAuthEnabled,
};

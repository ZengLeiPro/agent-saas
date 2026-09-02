import AsyncStorage from '@react-native-async-storage/async-storage';
import { identityScope, type BoundaryIdentity } from '@agent/shared';

export const LOCAL_APP_LOCK_POLICY_PREFIX = 'agentChat.localAppLock.v1::';
export const LOCAL_APP_LOCK_POLICY_VERSION = 1;

export interface LocalAppLockPolicy {
  version: 1;
  enabled: true;
  backgroundTimeoutMs: number;
}

function policyKey(identity: BoundaryIdentity): string {
  return `${LOCAL_APP_LOCK_POLICY_PREFIX}${identityScope(identity)}`;
}

export async function readLocalAppLockPolicy(identity: BoundaryIdentity): Promise<LocalAppLockPolicy | null> {
  const raw = await AsyncStorage.getItem(policyKey(identity));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LocalAppLockPolicy>;
    if (parsed.version !== LOCAL_APP_LOCK_POLICY_VERSION || parsed.enabled !== true ||
        typeof parsed.backgroundTimeoutMs !== 'number' || parsed.backgroundTimeoutMs < 0) {
      await AsyncStorage.removeItem(policyKey(identity));
      return null;
    }
    return parsed as LocalAppLockPolicy;
  } catch {
    await AsyncStorage.removeItem(policyKey(identity));
    return null;
  }
}

export async function writeLocalAppLockPolicy(
  identity: BoundaryIdentity,
  backgroundTimeoutMs: number,
): Promise<void> {
  const policy: LocalAppLockPolicy = {
    version: LOCAL_APP_LOCK_POLICY_VERSION,
    enabled: true,
    backgroundTimeoutMs,
  };
  await AsyncStorage.setItem(policyKey(identity), JSON.stringify(policy));
}

export async function removeLocalAppLockPolicy(identity: BoundaryIdentity): Promise<void> {
  await AsyncStorage.removeItem(policyKey(identity));
}

/** Logout/expiry/switch removes every prior identity policy; no account can inherit it. */
export async function clearAllLocalAppLockPolicies(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(LOCAL_APP_LOCK_POLICY_PREFIX));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}

/**
 * Enterprise-only Android APK updater.
 *
 * Store builds never mount this hook. Enterprise builds mount it only when the
 * controlled build flag, verification public key, key ID, and manifest URL were
 * all embedded by app.config.js.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import {
  cacheDirectory,
  deleteAsync,
  downloadAsync,
  getContentUriAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';
import type { EnterpriseUpdaterRuntimeConfig } from '../updates/enterpriseUpdaterConfig';
import {
  EnterpriseUpdateVerificationError,
  parseEnterpriseUpdateManifest,
  verifyDownloadedEnterpriseUpdate,
  verifyEnterpriseUpdateManifest,
  type EnterpriseUpdateManifest,
  type EnterpriseUpdatePolicy,
} from '../updates/enterpriseUpdateManifest';
import { sha256File } from '../updates/sha256File';

const CHECK_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const HIGHEST_ACCEPTED_PREFIX = 'agentSaas.enterpriseUpdater.highestAccepted';

function acceptedVersionKey(config: EnterpriseUpdaterRuntimeConfig): string {
  return `${HIGHEST_ACCEPTED_PREFIX}:${config.expectedPackage}:${config.keyId}`;
}

function parsePersistedVersion(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function installApk(uri: string): Promise<void> {
  const contentUri = await getContentUriAsync(uri);
  const IntentLauncher = require('expo-intent-launcher') as typeof import('expo-intent-launcher');
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1 | 268435456,
    type: 'application/vnd.android.package-archive',
  });
}

async function fetchManifest(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
  });
  if (!response.ok) throw new Error(`manifest request failed with HTTP ${response.status}`);
  const text = await response.text();
  if (!text || text.length > MAX_MANIFEST_BYTES) {
    throw new Error('manifest response is empty or exceeds the safety limit');
  }
  return JSON.parse(text) as unknown;
}

async function verifyLocalApk(
  uri: string,
  manifestValue: unknown,
  policy: EnterpriseUpdatePolicy,
): Promise<EnterpriseUpdateManifest> {
  const info = await getInfoAsync(uri);
  if (!info.exists || info.isDirectory) {
    throw new Error('downloaded APK is not a regular file');
  }
  const digest = await sha256File(uri, info.size);
  return verifyDownloadedEnterpriseUpdate(manifestValue, policy, {
    size: info.size,
    sha256: digest,
  });
}

async function obtainVerifiedApk(
  uri: string,
  manifestValue: unknown,
  manifest: EnterpriseUpdateManifest,
  policy: EnterpriseUpdatePolicy,
): Promise<void> {
  const existing = await getInfoAsync(uri);
  if (existing.exists && !existing.isDirectory && existing.size === manifest.size) {
    try {
      await verifyLocalApk(uri, manifestValue, policy);
      return;
    } catch {
      // A size match never authorizes cache reuse; delete any hash/signature mismatch.
    }
  }
  await deleteAsync(uri, { idempotent: true });
  const result = await downloadAsync(manifest.artifactUrl, uri, {
    headers: { 'Cache-Control': 'no-store' },
  });
  if (result.status !== 200) {
    await deleteAsync(uri, { idempotent: true });
    throw new Error(`APK download failed with HTTP ${result.status}`);
  }
  try {
    await verifyLocalApk(uri, manifestValue, policy);
  } catch (error) {
    await deleteAsync(uri, { idempotent: true });
    throw error;
  }
}

function reportUpdaterFailure(error: unknown): void {
  const code =
    error instanceof EnterpriseUpdateVerificationError ? error.code : 'UPDATE_CHECK_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  // Do not log fetched manifests, artifact URLs, signing material, or build secrets.
  console.warn(`[EnterpriseUpdater:${code}] ${message}`);
}

export function useEnterpriseUpdateChecker(config: EnterpriseUpdaterRuntimeConfig): void {
  const lastCheckRef = useRef(0);
  const busyRef = useRef(false);

  const check = useCallback(async () => {
    if (Platform.OS !== 'android' || !cacheDirectory || busyRef.current) return;
    if (Date.now() - lastCheckRef.current < CHECK_COOLDOWN_MS) return;

    busyRef.current = true;
    lastCheckRef.current = Date.now();
    let apkUri: string | null = null;

    try {
      const versionKey = acceptedVersionKey(config);
      const highestAcceptedVersionCode = parsePersistedVersion(
        await AsyncStorage.getItem(versionKey),
      );
      const manifestValue = await fetchManifest(config.manifestUrl);
      const parsed = parseEnterpriseUpdateManifest(manifestValue);
      const trustedFloor = Math.max(config.installedVersionCode, highestAcceptedVersionCode);
      if (parsed.versionCode <= trustedFloor) return;

      const policy: EnterpriseUpdatePolicy = {
        expectedPackage: config.expectedPackage,
        expectedFlavor: 'enterprise',
        installedVersionCode: config.installedVersionCode,
        highestAcceptedVersionCode,
        keyId: config.keyId,
        publicKey: config.publicKey,
      };
      const manifest = verifyEnterpriseUpdateManifest(manifestValue, policy);
      apkUri = `${cacheDirectory}AgentSaaS-enterprise-${manifest.versionCode}-${manifest.sha256.slice(0, 16)}.apk`;
      await obtainVerifiedApk(apkUri, manifestValue, manifest, policy);

      Alert.alert(
        '发现企业版更新',
        `v${manifest.marketingVersion}（${manifest.versionCode}）已完成安全验证，是否立即安装？`,
        [
          { text: '稍后', style: 'cancel' },
          {
            text: '安装',
            onPress: () => {
              void (async () => {
                try {
                  // Re-hash and re-verify immediately before invoking the package installer.
                  await verifyLocalApk(apkUri!, manifestValue, policy);
                  // Persist the anti-rollback floor only when the user accepts
                  // installation; choosing “later” must remain actionable.
                  await AsyncStorage.setItem(versionKey, String(manifest.versionCode));
                  await installApk(apkUri!);
                } catch (error) {
                  reportUpdaterFailure(error);
                  Alert.alert('安装失败', '更新包安全验证失败，已取消安装。');
                }
              })();
            },
          },
        ],
      );
    } catch (error) {
      if (apkUri) await deleteAsync(apkUri, { idempotent: true }).catch(() => undefined);
      reportUpdaterFailure(error);
    } finally {
      busyRef.current = false;
    }
  }, [config]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const timer = setTimeout(() => void check(), 3000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [check]);
}

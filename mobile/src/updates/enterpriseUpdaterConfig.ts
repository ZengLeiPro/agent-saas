import { toByteArray, fromByteArray } from 'base64-js';
import * as Application from 'expo-application';
import Constants from 'expo-constants';

export interface EnterpriseUpdaterRuntimeConfig {
  manifestUrl: string;
  publicKey: string;
  keyId: string;
  expectedPackage: string;
  installedVersionCode: number;
}

type ConstantsLike = Pick<typeof Constants, 'expoConfig'>;
type ApplicationLike = Pick<typeof Application, 'applicationId' | 'nativeBuildVersion'>;

function isCanonicalPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    const bytes = toByteArray(value);
    return bytes.length === 32 && fromByteArray(bytes) === value;
  } catch {
    return false;
  }
}

function isSafeManifestUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Reads only immutable build metadata. Any missing, malformed, or non-Enterprise
 * value disables the updater; Store and ambiguous builds therefore have no
 * runtime updater entry point.
 */
export function readEnterpriseUpdaterRuntimeConfig(
  constants: ConstantsLike = Constants,
  application: ApplicationLike = Application,
): EnterpriseUpdaterRuntimeConfig | null {
  const extra = constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const distribution = extra?.androidDistribution as Record<string, unknown> | undefined;
  const updater = extra?.enterpriseUpdater as Record<string, unknown> | undefined;
  if (
    distribution?.flavor !== 'enterprise' ||
    distribution.enterpriseUpdaterEnabled !== true ||
    updater?.enabled !== true
  ) {
    return null;
  }

  const configuredPackage = constants.expoConfig?.android?.package;
  const expectedPackage = application.applicationId;
  const nativeBuildVersion = application.nativeBuildVersion;
  const installedVersionCode =
    typeof nativeBuildVersion === 'string' && /^[1-9]\d*$/.test(nativeBuildVersion)
      ? Number(nativeBuildVersion)
      : 0;
  if (
    typeof configuredPackage !== 'string' ||
    configuredPackage !== expectedPackage ||
    typeof expectedPackage !== 'string' ||
    !expectedPackage ||
    !Number.isSafeInteger(installedVersionCode) ||
    installedVersionCode <= 0 ||
    !isSafeManifestUrl(updater.manifestUrl) ||
    !isCanonicalPublicKey(updater.publicKey) ||
    typeof updater.keyId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(updater.keyId)
  ) {
    return null;
  }

  return {
    manifestUrl: updater.manifestUrl,
    publicKey: updater.publicKey,
    keyId: updater.keyId,
    expectedPackage,
    installedVersionCode,
  };
}

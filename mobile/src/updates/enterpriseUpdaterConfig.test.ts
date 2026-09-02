import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: { expoConfig: null },
}));
vi.mock('expo-application', () => ({
  applicationId: null,
  nativeBuildVersion: null,
}));

import { readEnterpriseUpdaterRuntimeConfig } from './enterpriseUpdaterConfig';

const PUBLIC_KEY = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

function constantsFor(
  flavor: 'store' | 'enterprise',
  updaterEnabled: boolean,
  overrides: Record<string, unknown> = {},
) {
  return {
    expoConfig: {
      android: { package: 'com.agentsaas.mobile' },
      extra: {
        androidDistribution: {
          flavor,
          artifactType: flavor === 'store' ? 'aab' : 'apk',
          enterpriseUpdaterEnabled: updaterEnabled,
        },
        enterpriseUpdater: {
          enabled: true,
          manifestUrl: 'https://updates.example.test/android/enterprise/latest.json',
          publicKey: PUBLIC_KEY,
          keyId: 'enterprise-2026-01',
          ...overrides,
        },
      },
    },
  } as any;
}

function readConfig(
  constants: ReturnType<typeof constantsFor>,
  application: Record<string, unknown> = {},
) {
  return readEnterpriseUpdaterRuntimeConfig(constants, {
    applicationId: 'com.agentsaas.mobile',
    nativeBuildVersion: '85',
    ...application,
  } as any);
}

describe('M10-04 Enterprise updater build/runtime gate', () => {
  it('returns verified immutable build facts only for an enabled Enterprise build', () => {
    expect(readConfig(constantsFor('enterprise', true))).toEqual({
      manifestUrl: 'https://updates.example.test/android/enterprise/latest.json',
      publicKey: PUBLIC_KEY,
      keyId: 'enterprise-2026-01',
      expectedPackage: 'com.agentsaas.mobile',
      installedVersionCode: 85,
    });
  });

  it('has no Store updater runtime path even if updater data is present', () => {
    expect(readConfig(constantsFor('store', true))).toBeNull();
  });

  it('defaults Enterprise updater off unless the build capability is enabled', () => {
    expect(readConfig(constantsFor('enterprise', false))).toBeNull();
  });

  it('fails closed on missing native version, insecure URL, bad public key, or bad key ID', () => {
    const valid = constantsFor('enterprise', true);
    expect(readConfig(valid, { nativeBuildVersion: '0' })).toBeNull();
    expect(readConfig(valid, { applicationId: 'com.other.application' })).toBeNull();
    expect(
      readConfig(
        constantsFor('enterprise', true, { manifestUrl: 'http://updates.example.test/latest' }),
      ),
    ).toBeNull();
    expect(
      readConfig(constantsFor('enterprise', true, { publicKey: 'not-a-public-key' })),
    ).toBeNull();
    expect(readConfig(constantsFor('enterprise', true, { keyId: '../../secret' }))).toBeNull();
  });
});

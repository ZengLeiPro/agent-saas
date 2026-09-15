import type { KyAppInstallation } from './systems/types.js';

export type KyAppProtocolVersion = 'v1' | 'v2';

export interface KyAppRuntimePaths {
  version: KyAppProtocolVersion;
  live: string;
  ready: string;
  manifest: string;
  attest(installationId: string, nonce: string): string;
  me: string;
  events: string;
  capability(capabilityId: string): string;
  execution(capabilityId: string, lcid: string): string;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

const v1: KyAppRuntimePaths = {
  version: 'v1',
  live: '/ky/v1/health/live',
  ready: '/ky/v1/health/ready',
  manifest: '/ky/v1/manifest',
  attest: (_installationId, nonce) => `/ky/v1/attest?nonce=${segment(nonce)}`,
  me: '/ky/v1/me',
  events: '/ky/v1/events',
  capability: (capabilityId) => `/ky/v1/capabilities/${segment(capabilityId)}`,
  execution: (capabilityId, lcid) =>
    `/ky/v1/capabilities/${segment(capabilityId)}/executions/${segment(lcid)}`,
};

const v2: KyAppRuntimePaths = {
  version: 'v2',
  live: '/ky/v2/health/live',
  ready: '/ky/v2/health/ready',
  manifest: '/ky/v2/manifest',
  attest: (installationId, nonce) =>
    `/ky/v2/attest?iid=${segment(installationId)}&nonce=${segment(nonce)}`,
  me: '/ky/v2/me',
  events: '/ky/v2/events',
  capability: (capabilityId) => `/ky/v2/capabilities/${segment(capabilityId)}`,
  execution: (capabilityId, lcid) =>
    `/ky/v2/capabilities/${segment(capabilityId)}/executions/${segment(lcid)}`,
};

/** V2 实例绝不探测或回退 V1；缺省仅用于迁移前的明确存量实例。 */
export function kyAppRuntimePaths(authMode: KyAppInstallation['authMode']): KyAppRuntimePaths {
  return authMode === 'v2_asymmetric' ? v2 : v1;
}

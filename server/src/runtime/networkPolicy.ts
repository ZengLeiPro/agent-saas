import { isIP } from 'node:net';

export const NETWORK_POLICY_MODES = ['isolated', 'public-egress', 'private-egress'] as const;
export type NetworkPolicyMode = typeof NETWORK_POLICY_MODES[number];

export const DEFAULT_DENY_PRIVATE_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '100.100.100.200/32',
  '127.0.0.0/8',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

export interface NetworkPolicyConfig {
  mode: NetworkPolicyMode;
  denyPrivateNetworks: boolean;
  allowCidrs?: string[];
  allowDomains?: string[];
  denyCidrs?: string[];
}

export interface EffectiveNetworkPolicy {
  mode: NetworkPolicyMode | 'unknown';
  enforcement: 'enforced' | 'not_enforced' | 'unknown';
  publicEgressReachable: boolean | 'unknown';
  privateEgressBlocked: boolean | 'unknown';
  metadataBlocked: boolean | 'unknown';
  dnsRebindingProtected: boolean | 'unknown';
  checkedAt?: string;
  probeSandboxName?: string;
  note: string;
}

export interface NetworkPolicyStatus {
  desiredPolicy: NetworkPolicyConfig;
  effectivePolicy: EffectiveNetworkPolicy;
}

export const DEFAULT_CODING_HAND_NETWORK_POLICY: NetworkPolicyConfig = Object.freeze({
  mode: 'public-egress',
  denyPrivateNetworks: true,
});

export const DEFAULT_ISOLATED_NETWORK_POLICY: NetworkPolicyConfig = Object.freeze({
  mode: 'isolated',
  denyPrivateNetworks: true,
});

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export function isNetworkPolicyMode(value: unknown): value is NetworkPolicyMode {
  return typeof value === 'string' && (NETWORK_POLICY_MODES as readonly string[]).includes(value);
}

export function isValidCidr(value: string): boolean {
  const [addr, prefix, extra] = value.split('/');
  if (!addr || prefix === undefined || extra !== undefined) return false;
  const family = isIP(addr);
  if (family === 0) return false;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number.parseInt(prefix, 10);
  return family === 4
    ? bits >= 0 && bits <= 32
    : bits >= 0 && bits <= 128;
}

export function isValidDomain(value: string): boolean {
  if (!value || value.includes('://') || value.includes('/') || value.includes('*')) return false;
  return DOMAIN_RE.test(value);
}

function normalizeList(values: string[] | undefined, validator: (value: string) => boolean, label: string): string[] | undefined {
  if (!values?.length) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (!validator(value)) throw new Error(`${label} 非法: ${value}`);
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized.length ? normalized : undefined;
}

export function normalizeNetworkPolicy(
  input: Partial<NetworkPolicyConfig> | undefined,
  fallback: NetworkPolicyConfig = DEFAULT_CODING_HAND_NETWORK_POLICY,
): NetworkPolicyConfig {
  const mode = input?.mode ?? fallback.mode;
  if (!isNetworkPolicyMode(mode)) throw new Error(`networkPolicy.mode 非法: ${String(mode)}`);
  const allowCidrs = normalizeList(input?.allowCidrs, isValidCidr, 'networkPolicy.allowCidrs');
  const denyCidrs = normalizeList(input?.denyCidrs, isValidCidr, 'networkPolicy.denyCidrs');
  const allowDomains = normalizeList(input?.allowDomains, isValidDomain, 'networkPolicy.allowDomains');
  if (mode !== 'private-egress' && (allowCidrs?.length || allowDomains?.length)) {
    throw new Error('networkPolicy.allowCidrs/allowDomains 只允许 private-egress 使用');
  }
  if (mode === 'private-egress' && allowCidrs?.some((cidr) => cidr === '0.0.0.0/0' || cidr === '::/0')) {
    throw new Error('networkPolicy.private-egress 不允许使用 0.0.0.0/0 或 ::/0；需要公网请使用 public-egress');
  }
  return {
    mode,
    denyPrivateNetworks: input?.denyPrivateNetworks ?? fallback.denyPrivateNetworks ?? true,
    ...(allowCidrs ? { allowCidrs } : {}),
    ...(allowDomains ? { allowDomains } : {}),
    ...(denyCidrs ? { denyCidrs } : {}),
  };
}

export function parseNetworkPolicyFromEnv(
  env: NodeJS.ProcessEnv,
  prefix: string,
  fallback: NetworkPolicyConfig,
): NetworkPolicyConfig {
  const mode = env[`${prefix}_MODE`]?.trim();
  const denyPrivateRaw = env[`${prefix}_DENY_PRIVATE_NETWORKS`]?.trim().toLowerCase();
  const denyPrivateNetworks = denyPrivateRaw
    ? ['1', 'true', 'yes', 'on'].includes(denyPrivateRaw)
      ? true
      : ['0', 'false', 'no', 'off'].includes(denyPrivateRaw)
        ? false
        : undefined
    : undefined;
  if (denyPrivateRaw && denyPrivateNetworks === undefined) {
    throw new Error(`${prefix}_DENY_PRIVATE_NETWORKS 非法: ${env[`${prefix}_DENY_PRIVATE_NETWORKS`]}`);
  }
  return normalizeNetworkPolicy({
    ...(mode ? { mode: mode as NetworkPolicyMode } : {}),
    ...(denyPrivateNetworks !== undefined ? { denyPrivateNetworks } : {}),
    allowCidrs: splitEnvList(env[`${prefix}_ALLOW_CIDRS`]),
    allowDomains: splitEnvList(env[`${prefix}_ALLOW_DOMAINS`]),
    denyCidrs: splitEnvList(env[`${prefix}_DENY_CIDRS`]),
  }, fallback);
}

function splitEnvList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function resolveDockerNetworkName(policy: NetworkPolicyConfig, explicitNetwork?: string): string {
  if (policy.mode === 'isolated') return 'none';
  if (explicitNetwork) {
    assertSafeDockerNetworkName(explicitNetwork);
    return explicitNetwork;
  }
  return 'none';
}

export function assertSafeDockerNetworkName(value: string): void {
  if (value === 'host') throw new Error('Docker host network is forbidden for coding hands');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`Docker network name 非法: ${value}`);
  }
}

export function dockerNetworkPolicyStatus(
  desiredPolicy: NetworkPolicyConfig,
  dockerNetwork: string,
): NetworkPolicyStatus {
  if (dockerNetwork === 'none') {
    return {
      desiredPolicy,
      effectivePolicy: {
        mode: 'isolated',
        enforcement: desiredPolicy.mode === 'isolated' ? 'enforced' : 'not_enforced',
        publicEgressReachable: false,
        privateEgressBlocked: true,
        metadataBlocked: true,
        dnsRebindingProtected: true,
        note: desiredPolicy.mode === 'isolated'
          ? 'Docker is running with --network none.'
          : 'Desired egress policy is not enforced yet; Docker is still running with --network none.',
      },
    };
  }
  return {
    desiredPolicy,
    effectivePolicy: {
      mode: desiredPolicy.mode === 'isolated' ? 'unknown' : desiredPolicy.mode,
      enforcement: 'unknown',
      publicEgressReachable: 'unknown',
      privateEgressBlocked: 'unknown',
      metadataBlocked: 'unknown',
      dnsRebindingProtected: 'unknown',
      note: `Docker network ${dockerNetwork} is configured; private/metadata blocking requires host firewall or probe confirmation.`,
    },
  };
}

export function unknownNetworkPolicyStatus(
  desiredPolicy: NetworkPolicyConfig,
  note: string,
): NetworkPolicyStatus {
  return {
    desiredPolicy,
    effectivePolicy: {
      mode: 'unknown',
      enforcement: 'unknown',
      publicEgressReachable: 'unknown',
      privateEgressBlocked: 'unknown',
      metadataBlocked: 'unknown',
      dnsRebindingProtected: 'unknown',
      note,
    },
  };
}

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CODING_HAND_NETWORK_POLICY,
  DEFAULT_ISOLATED_NETWORK_POLICY,
  dockerNetworkPolicyStatus,
  normalizeNetworkPolicy,
  resolveDockerNetworkName,
} from '../runtime/networkPolicy.js';

describe('networkPolicy helpers', () => {
  it('normalizes defaults and private-egress allow-lists', () => {
    expect(normalizeNetworkPolicy(undefined, DEFAULT_CODING_HAND_NETWORK_POLICY)).toEqual({
      mode: 'public-egress',
      denyPrivateNetworks: true,
    });
    expect(normalizeNetworkPolicy({
      mode: 'private-egress',
      allowCidrs: ['10.0.0.0/8', '10.0.0.0/8'],
      allowDomains: ['internal.example.com'],
    })).toEqual({
      mode: 'private-egress',
      denyPrivateNetworks: true,
      allowCidrs: ['10.0.0.0/8'],
      allowDomains: ['internal.example.com'],
    });
  });

  it('rejects domain allow-lists outside private-egress and unsafe docker networks', () => {
    expect(() => normalizeNetworkPolicy({
      mode: 'public-egress',
      allowDomains: ['internal.example.com'],
    })).toThrow(/private-egress/);
    expect(() => normalizeNetworkPolicy({
      mode: 'private-egress',
      allowCidrs: ['0.0.0.0/0'],
    })).toThrow(/不允许使用/);
    expect(() => resolveDockerNetworkName(DEFAULT_CODING_HAND_NETWORK_POLICY, 'host'))
      .toThrow(/host network is forbidden/);
  });

  it('keeps Docker isolated unless a safe explicit network is provided', () => {
    const isolatedNetwork = resolveDockerNetworkName(DEFAULT_ISOLATED_NETWORK_POLICY);
    expect(isolatedNetwork).toBe('none');
    expect(dockerNetworkPolicyStatus(DEFAULT_ISOLATED_NETWORK_POLICY, isolatedNetwork)).toMatchObject({
      effectivePolicy: {
        mode: 'isolated',
        enforcement: 'enforced',
        publicEgressReachable: false,
        privateEgressBlocked: true,
        metadataBlocked: true,
      },
    });

    const publicNetwork = resolveDockerNetworkName(DEFAULT_CODING_HAND_NETWORK_POLICY);
    expect(publicNetwork).toBe('none');
    expect(dockerNetworkPolicyStatus(DEFAULT_CODING_HAND_NETWORK_POLICY, publicNetwork)).toMatchObject({
      effectivePolicy: {
        mode: 'isolated',
        enforcement: 'not_enforced',
        publicEgressReachable: false,
        privateEgressBlocked: true,
        metadataBlocked: true,
      },
    });
  });
});

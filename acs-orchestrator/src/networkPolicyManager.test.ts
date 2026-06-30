import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildTrafficPolicyManifest, trafficPolicyNameFor } from './networkPolicyManager.js';

describe('AcsNetworkPolicyManager helpers', () => {
  it('builds public-egress TrafficPolicy with DNS allow, private deny, then public allow', () => {
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: { name: 'as-session-abcdef', workspaceId: 'ws_kaiyan__test', sandboxScopeId: 'ws_kaiyan__test', sessionId: 'session-123', mountSubPath: 'workspaces/kaiyan/u-1' },
      policy: { mode: 'public-egress', denyPrivateNetworks: true },
    });

    expect(manifest).toMatchObject({
      apiVersion: 'network.alibabacloud.com/v1alpha1',
      kind: 'TrafficPolicy',
      metadata: {
        name: trafficPolicyNameFor('as-session-abcdef'),
        namespace: 'agent-saas-coding',
      },
      spec: {
        priority: 100,
        selector: {
          matchLabels: {
            'app.kubernetes.io/name': 'agent-saas-coding-hand',
            'app.kubernetes.io/managed-by': 'agent-saas-acs-orchestrator',
            'agent-saas.kaiyan.net/workspace-id': labelValue('ws_kaiyan__test'),
            'agent-saas.kaiyan.net/sandbox-scope-id': labelValue('ws_kaiyan__test'),
          },
        },
      },
    });
    const rules = ((manifest.spec as any).egress.rules ?? []) as any[];
    expect(rules[0]).toEqual({
      action: 'allow',
      to: [
        { service: { namespace: 'kube-system', name: 'kube-dns' } },
        { cidr: '100.100.2.136/32' },
        { cidr: '100.100.2.138/32' },
      ],
    });
    expect(rules[1].action).toBe('deny');
    expect(rules[1].to).toContainEqual({ cidr: '100.100.100.200/32' });
    expect(rules[1].to).toContainEqual({ cidr: '172.16.0.0/12' });
    expect(rules[1].to).toContainEqual({ cidr: '100.64.0.0/10' });
    expect(rules.at(-1)).toEqual({ action: 'allow', to: [{ cidr: '0.0.0.0/0' }] });
  });

  it('builds private-egress TrafficPolicy as allow-list plus deny-all fallback', () => {
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: { name: 'as-session-abcdef', workspaceId: 'ws_kaiyan__test', sandboxScopeId: 'ws_kaiyan__test', sessionId: 'session-123', mountSubPath: 'workspaces/kaiyan/u-1' },
      policy: {
        mode: 'private-egress',
        denyPrivateNetworks: true,
        allowCidrs: ['10.8.0.0/16'],
        allowDomains: ['internal.example.com'],
      },
    });
    const rules = ((manifest.spec as any).egress.rules ?? []) as any[];
    expect(rules[0]).toEqual({
      action: 'allow',
      to: [
        { service: { namespace: 'kube-system', name: 'kube-dns' } },
        { cidr: '100.100.2.136/32' },
        { cidr: '100.100.2.138/32' },
      ],
    });
    expect(rules[1]).toEqual({ action: 'deny', to: [{ cidr: '100.100.100.200/32' }] });
    expect(rules[2]).toEqual({ action: 'allow', to: [{ cidr: '10.8.0.0/16' }, { fqdn: 'internal.example.com' }] });
    expect(rules.at(-1)).toEqual({ action: 'deny', to: [{ cidr: '0.0.0.0/0' }] });
  });
});

function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

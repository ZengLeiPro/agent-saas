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
    expect(rules[1]).toEqual({ action: 'deny', to: [{ cidr: '100.100.100.200/32' }] });
    expect(rules[2].action).toBe('deny');
    expect(rules[2].to).toContainEqual({ cidr: '172.16.0.0/12' });
    expect(rules[2].to).toContainEqual({ cidr: '100.64.0.0/10' });
    expect(rules.at(-1)).toEqual({ action: 'allow', to: [{ cidr: '0.0.0.0/0' }] });
  });

  it('public-egress 即使关闭私网阻断且没有 denyCidrs 也先阻断 metadata', () => {
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: { name: 'as-session-abcdef', workspaceId: 'ws_kaiyan__test', sandboxScopeId: 'ws_kaiyan__test', sessionId: 'session-123', mountSubPath: 'workspaces/kaiyan/u-1' },
      policy: { mode: 'public-egress', denyPrivateNetworks: false },
    });
    const rules = ((manifest.spec as any).egress.rules ?? []) as any[];

    expect(rules[1]).toEqual({ action: 'deny', to: [{ cidr: '100.100.100.200/32' }] });
    expect(rules[2]).toEqual({ action: 'allow', to: [{ cidr: '0.0.0.0/0' }] });
    expect(rules).toHaveLength(3);
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

  const REF = {
    name: 'as-session-abcdef',
    workspaceId: 'ws_kaiyan__test',
    sandboxScopeId: 'ws_kaiyan__test',
    sessionId: 'session-123',
    mountSubPath: 'workspaces/kaiyan/u-1',
  };

  it('public-egress 下把出口代理 /32 放行在私网 deny 之前', () => {
    // 代理落在 172.16.0.0/12 里，若 allow 排在 deny 之后就会被整段私网 deny 吃掉，
    // 表现为「代理配了但容器连不上」——这条断言就是防这个回归。
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: REF,
      policy: { mode: 'public-egress', denyPrivateNetworks: true },
      extraAllowCidrs: ['172.16.177.77/32'],
    });
    const rules = ((manifest.spec as any).egress.rules ?? []) as any[];
    expect(rules[0].action).toBe('allow');
    expect(rules[0].to).toContainEqual({ service: { namespace: 'kube-system', name: 'kube-dns' } });
    expect(rules[1]).toEqual({ action: 'deny', to: [{ cidr: '100.100.100.200/32' }] });
    expect(rules[2]).toEqual({ action: 'allow', to: [{ cidr: '172.16.177.77/32' }] });
    expect(rules[3].action).toBe('deny');
    expect(rules[3].to).toContainEqual({ cidr: '172.16.0.0/12' });
    expect(rules.at(-1)).toEqual({ action: 'allow', to: [{ cidr: '0.0.0.0/0' }] });
  });

  it('无出口代理时规则形状与改造前完全一致', () => {
    const before = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: REF,
      policy: { mode: 'public-egress', denyPrivateNetworks: true },
    });
    const withEmpty = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: REF,
      policy: { mode: 'public-egress', denyPrivateNetworks: true },
      extraAllowCidrs: [],
    });
    expect((withEmpty.spec as any).egress.rules).toEqual((before.spec as any).egress.rules);
  });

  it('元数据服务永远不进 allow —— 误配也不能拿到 ECS 临时凭据', () => {
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: REF,
      policy: {
        mode: 'public-egress',
        denyPrivateNetworks: true,
        allowCidrs: ['100.100.100.200/32', '172.16.177.77/32'],
      },
      extraAllowCidrs: ['100.100.100.200/32'],
    });
    const rules = ((manifest.spec as any).egress.rules ?? []) as any[];
    const allowRules = rules.filter((rule) => rule.action === 'allow');
    for (const rule of allowRules) {
      expect(rule.to).not.toContainEqual({ cidr: '100.100.100.200/32' });
    }
    expect(rules[1]).toEqual({ action: 'deny', to: [{ cidr: '100.100.100.200/32' }] });
    // 正常代理地址仍然放行，但排在 metadata deny 之后
    expect(rules[2]).toEqual({ action: 'allow', to: [{ cidr: '172.16.177.77/32' }] });
  });

  it('public-egress 的宽 CIDR 不能越过前置 metadata deny', () => {
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: REF,
      policy: { mode: 'public-egress', denyPrivateNetworks: false },
      extraAllowCidrs: [
        '100.100.100.0/24',
        '100.100.96.0/20',
        '0.0.0.0/0',
        '172.16.177.77/32',
      ],
    });
    const rules = ((manifest.spec as any).egress.rules ?? []) as any[];

    expect(rules[1]).toEqual({ action: 'deny', to: [{ cidr: '100.100.100.200/32' }] });
    expect(rules[2]).toEqual({ action: 'allow', to: [{ cidr: '172.16.177.77/32' }] });
    expect(rules[3]).toEqual({ action: 'allow', to: [{ cidr: '0.0.0.0/0' }] });
  });

  it('按 CIDR 包含关系拒绝可覆盖 metadata IP 的宽网段放行', () => {
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: REF,
      policy: {
        mode: 'private-egress',
        denyPrivateNetworks: false,
        allowCidrs: [
          '100.100.100.0/24',
          '100.100.0.0/16',
          '0.0.0.0/0',
          '100.100.101.0/24',
        ],
      },
      extraAllowCidrs: ['100.100.96.0/20'],
    });
    const rules = ((manifest.spec as any).egress.rules ?? []) as any[];
    const explicitAllows = rules
      .filter((rule) => rule.action === 'allow')
      .flatMap((rule) => rule.to ?? [])
      .filter((peer: any) => typeof peer.cidr === 'string')
      .map((peer: any) => peer.cidr);

    expect(explicitAllows).toContain('100.100.101.0/24');
    expect(explicitAllows).not.toContain('100.100.100.0/24');
    expect(explicitAllows).not.toContain('100.100.0.0/16');
    expect(explicitAllows).not.toContain('100.100.96.0/20');
    expect(explicitAllows).not.toContain('0.0.0.0/0');
  });

  it('isolated 模式下代理也不放行（隔离语义不留后门）', () => {
    const manifest = buildTrafficPolicyManifest({
      namespace: 'agent-saas-coding',
      ref: REF,
      policy: { mode: 'isolated', denyPrivateNetworks: true },
      extraAllowCidrs: ['172.16.177.77/32'],
    });
    expect((manifest.spec as any).egress.rules).toEqual([
      { action: 'deny', to: [{ cidr: '100.100.100.200/32' }] },
      { action: 'deny', to: [{ cidr: '0.0.0.0/0' }] },
    ]);
  });
});

function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

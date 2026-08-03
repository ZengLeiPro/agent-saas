import { describe, expect, it } from 'vitest';

import { parseKubeconfig, splitCrdName } from './kubeApi.js';

describe('splitCrdName', () => {
  it('拆出 plural 与 group', () => {
    expect(splitCrdName('sandboxes.agents.kruise.io')).toEqual({ plural: 'sandboxes', group: 'agents.kruise.io' });
    expect(splitCrdName('trafficpolicies.network.alibabacloud.com')).toEqual({ plural: 'trafficpolicies', group: 'network.alibabacloud.com' });
  });

  it('非法输入返回 null', () => {
    expect(splitCrdName('nodot')).toBeNull();
    expect(splitCrdName('.leading')).toBeNull();
    expect(splitCrdName('trailing.')).toBeNull();
  });
});

describe('parseKubeconfig', () => {
  const CA_B64 = Buffer.from('fake-ca').toString('base64');

  it('解析 token + CA kubeconfig（生产 ACS 最小 RBAC 形态）', () => {
    const creds = parseKubeconfig([
      'apiVersion: v1',
      'clusters:',
      '- cluster:',
      `    certificate-authority-data: ${CA_B64}`,
      '    server: https://172.18.190.64:6443',
      '  name: acs',
      'users:',
      '- name: acs-user',
      '  user:',
      '    token: abc.def.ghi',
    ].join('\n'));
    expect(creds).not.toBeNull();
    expect(creds!.server).toBe('https://172.18.190.64:6443');
    expect(creds!.token).toBe('abc.def.ghi');
    expect(creds!.ca?.toString('utf-8')).toBe('fake-ca');
    expect(creds!.insecureSkipTlsVerify).toBe(false);
  });

  it('解析 client-cert kubeconfig', () => {
    const creds = parseKubeconfig([
      `    certificate-authority-data: ${CA_B64}`,
      '    server: https://10.0.0.1:6443',
      `    client-certificate-data: ${Buffer.from('cert').toString('base64')}`,
      `    client-key-data: ${Buffer.from('key').toString('base64')}`,
    ].join('\n'));
    expect(creds).not.toBeNull();
    expect(creds!.token).toBeUndefined();
    expect(creds!.clientCert?.toString('utf-8')).toBe('cert');
    expect(creds!.clientKey?.toString('utf-8')).toBe('key');
  });

  it('多 cluster（同字段多个不同值）→ 歧义返回 null', () => {
    const creds = parseKubeconfig([
      '    server: https://10.0.0.1:6443',
      '    token: token-a',
      '    server: https://10.0.0.2:6443',
      '    token: token-b',
    ].join('\n'));
    expect(creds).toBeNull();
  });

  it('无认证材料返回 null；http server 返回 null', () => {
    expect(parseKubeconfig('    server: https://10.0.0.1:6443')).toBeNull();
    expect(parseKubeconfig('    server: http://10.0.0.1:8080\n    token: t')).toBeNull();
  });
});

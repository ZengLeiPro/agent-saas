import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CN_DIRECT_SUFFIXES,
  DEFAULT_EGRESS_CONFIG,
  FORCED_SANDBOX_NO_PROXY,
  buildNoProxyList,
  buildPackageMirrorEnv,
  buildSandboxProxyEnv,
  egressSandboxFingerprint,
  parseProxyUrl,
  proxyHostCidr,
  shouldProxyHost,
  type EgressServerProxyConfig,
} from '../runtime/egressPolicy.js';

function serverConfig(overrides: Partial<EgressServerProxyConfig> = {}): EgressServerProxyConfig {
  return { ...DEFAULT_EGRESS_CONFIG.server, ...overrides };
}

describe('parseProxyUrl', () => {
  it('接受 http/https/socks5 并补默认端口', () => {
    expect(parseProxyUrl('http://172.16.177.77:7890')).toMatchObject({
      protocol: 'http:',
      hostname: '172.16.177.77',
      port: '7890',
      sanitizedUrl: 'http://172.16.177.77:7890',
    });
    expect(parseProxyUrl('https://proxy.example.com')?.port).toBe('443');
    expect(parseProxyUrl('socks5://127.0.0.1:1080')?.protocol).toBe('socks5:');
  });

  it('拒绝空值、非法 URL 与不支持的协议', () => {
    expect(parseProxyUrl('')).toBeNull();
    expect(parseProxyUrl('   ')).toBeNull();
    expect(parseProxyUrl('172.16.177.77:7890')).toBeNull();
    expect(parseProxyUrl('ftp://proxy.example.com')).toBeNull();
  });

  it('不把凭据带进 sanitizedUrl', () => {
    const parsed = parseProxyUrl('http://user:secret@10.0.0.1:8080');
    expect(parsed?.sanitizedUrl).toBe('http://10.0.0.1:8080');
    expect(parsed?.sanitizedUrl).not.toContain('secret');
  });
});

describe('proxyHostCidr', () => {
  it('IP 主机返回 /32，供 TrafficPolicy 自动放行', () => {
    expect(proxyHostCidr('http://172.16.177.77:7890')).toBe('172.16.177.77/32');
  });

  it('域名主机返回 null（需管理员自行放行）', () => {
    expect(proxyHostCidr('http://proxy.example.com:7890')).toBeNull();
    expect(proxyHostCidr('not-a-url')).toBeNull();
  });
});

describe('buildNoProxyList', () => {
  it('强制项始终在前且不可被去掉', () => {
    const list = buildNoProxyList([]);
    for (const forced of FORCED_SANDBOX_NO_PROXY) {
      expect(list).toContain(forced);
    }
    // VPC DNS 缺失会让容器 DNS 整体走代理并失败，是最关键的一条
    expect(list).toContain('100.100.2.136');
    expect(list).toContain('100.100.2.138');
  });

  it('合并管理员配置并去重', () => {
    const list = buildNoProxyList(['example.com', 'localhost', ' example.com ']);
    expect(list.filter((item) => item === 'example.com')).toHaveLength(1);
    expect(list.filter((item) => item === 'localhost')).toHaveLength(1);
  });
});

describe('buildSandboxProxyEnv', () => {
  it('未启用时不注入任何变量', () => {
    expect(buildSandboxProxyEnv({ enabled: false, proxyUrl: 'http://1.2.3.4:8080', noProxy: [] })).toEqual([]);
  });

  it('地址非法时不注入（避免把坏值写进 Pod spec）', () => {
    expect(buildSandboxProxyEnv({ enabled: true, proxyUrl: 'nonsense', noProxy: [] })).toEqual([]);
  });

  it('大小写各注一份——Chromium 与 curl 只认小写，Go 二进制认大写', () => {
    const env = buildSandboxProxyEnv({
      enabled: true,
      proxyUrl: 'http://172.16.177.77:7890',
      noProxy: ['internal.example.com'],
    });
    const names = env.map((entry) => entry.name);
    expect(names).toEqual([
      'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
    ]);
    const byName = Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
    expect(byName.HTTP_PROXY).toBe('http://172.16.177.77:7890');
    expect(byName.http_proxy).toBe(byName.HTTP_PROXY);
    expect(byName.no_proxy).toBe(byName.NO_PROXY);
    expect(byName.NO_PROXY).toContain('internal.example.com');
    expect(byName.NO_PROXY).toContain('100.100.2.136');
  });
});

describe('DEFAULT_CN_DIRECT_SUFFIXES 境内兜底', () => {
  it('容器段默认就带境内后缀——它没有 fail-open，代理挂了这是唯一退路', () => {
    expect(DEFAULT_EGRESS_CONFIG.sandbox.noProxy.length).toBeGreaterThan(0);
    for (const suffix of DEFAULT_CN_DIRECT_SUFFIXES) {
      expect(DEFAULT_EGRESS_CONFIG.sandbox.noProxy).toContain(suffix);
    }
    // 镜像源与自家服务必须能在代理故障时直连
    expect(DEFAULT_CN_DIRECT_SUFFIXES).toContain('.aliyun.com');
    expect(DEFAULT_CN_DIRECT_SUFFIXES).toContain('.npmmirror.com');
    expect(DEFAULT_CN_DIRECT_SUFFIXES).toContain('.kaiyan.net');
  });

  it('境内兜底与强制项合并后无重复', () => {
    const list = buildNoProxyList([...DEFAULT_CN_DIRECT_SUFFIXES]);
    expect(new Set(list).size).toBe(list.length);
    // 强制项仍在最前
    expect(list[0]).toBe(FORCED_SANDBOX_NO_PROXY[0]);
  });

  it('境内兜底会真正进入 Pod env 的 NO_PROXY', () => {
    const env = buildSandboxProxyEnv({
      enabled: true,
      proxyUrl: 'http://172.16.177.77:7890',
      noProxy: [...DEFAULT_CN_DIRECT_SUFFIXES],
    });
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(byName.NO_PROXY).toContain('.aliyun.com');
    expect(byName.NO_PROXY).toContain('.dingtalk.com');
    expect(byName.no_proxy).toBe(byName.NO_PROXY);
  });
});

describe('buildPackageMirrorEnv', () => {
  it('未启用时为空', () => {
    expect(buildPackageMirrorEnv(DEFAULT_EGRESS_CONFIG.packageMirrors)).toEqual([]);
  });

  it('启用后注入 pip / npm 源', () => {
    const env = buildPackageMirrorEnv({
      enabled: true,
      pipIndexUrl: 'https://mirrors.aliyun.com/pypi/simple/',
      pipTrustedHost: 'mirrors.aliyun.com',
      npmRegistry: 'https://registry.npmmirror.com',
    });
    expect(env.map((entry) => entry.name)).toEqual([
      'PIP_INDEX_URL', 'PIP_TRUSTED_HOST', 'NPM_CONFIG_REGISTRY',
    ]);
  });

  it('空字符串字段被跳过，不写空值 env', () => {
    const env = buildPackageMirrorEnv({
      enabled: true,
      pipIndexUrl: 'https://example.com/simple/',
      pipTrustedHost: '  ',
      npmRegistry: '',
    });
    expect(env.map((entry) => entry.name)).toEqual(['PIP_INDEX_URL']);
  });
});

describe('shouldProxyHost', () => {
  const enabled = serverConfig({ enabled: true, proxyUrl: 'http://172.16.177.77:7890' });

  it('未启用或地址非法时一律直连', () => {
    expect(shouldProxyHost('example.com', serverConfig({ enabled: false }))).toBe(false);
    expect(shouldProxyHost('example.com', serverConfig({ enabled: true, proxyUrl: '' }))).toBe(false);
  });

  it('matchDomains 为空表示全部走代理', () => {
    expect(shouldProxyHost('anything.com', enabled)).toBe(true);
  });

  it('后缀匹配命中子域但不命中相似域', () => {
    const config = serverConfig({ ...enabled, matchDomains: ['example.com'] });
    expect(shouldProxyHost('example.com', config)).toBe(true);
    expect(shouldProxyHost('a.b.example.com', config)).toBe(true);
    expect(shouldProxyHost('notexample.com', config)).toBe(false);
    expect(shouldProxyHost('example.com.cn', config)).toBe(false);
  });

  it('bypass 优先于 match', () => {
    const config = serverConfig({
      ...enabled,
      matchDomains: ['example.com'],
      bypassDomains: ['internal.example.com'],
    });
    expect(shouldProxyHost('internal.example.com', config)).toBe(false);
    expect(shouldProxyHost('other.example.com', config)).toBe(true);
  });

  it('大小写与前导点不敏感', () => {
    const config = serverConfig({ ...enabled, matchDomains: ['.Example.COM'] });
    expect(shouldProxyHost('WWW.example.com', config)).toBe(true);
  });
});

describe('egressSandboxFingerprint', () => {
  it('配置相同则指纹相同，任一变化则指纹变化', () => {
    const sandbox = { enabled: true, proxyUrl: 'http://1.2.3.4:8080', noProxy: [] };
    const mirrors = DEFAULT_EGRESS_CONFIG.packageMirrors;
    const base = egressSandboxFingerprint(sandbox, mirrors);
    expect(egressSandboxFingerprint({ ...sandbox }, mirrors)).toBe(base);
    expect(egressSandboxFingerprint({ ...sandbox, proxyUrl: 'http://1.2.3.5:8080' }, mirrors)).not.toBe(base);
    expect(egressSandboxFingerprint(sandbox, { ...mirrors, enabled: true })).not.toBe(base);
  });
});

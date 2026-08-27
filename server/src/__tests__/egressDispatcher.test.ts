import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EgressDispatcherRegistry,
  createEgressFetch,
  createWebToolEgressFetch,
  installStagingGlobalEgressFetch,
  type EgressConfigSource,
} from '../runtime/egressDispatcher.js';
import { DEFAULT_EGRESS_CONFIG, type EgressConfig } from '../runtime/egressPolicy.js';

function makeSource(initial: Partial<EgressConfig['server']> = {}) {
  let version = 0;
  let config: EgressConfig = {
    ...DEFAULT_EGRESS_CONFIG,
    server: { ...DEFAULT_EGRESS_CONFIG.server, ...initial },
  };
  const source: EgressConfigSource & {
    set(next: Partial<EgressConfig['server']>): void;
  } = {
    getConfig: () => config,
    getConfigVersion: () => version,
    set(next) {
      config = { ...config, server: { ...config.server, ...next } };
      version += 1;
    },
  };
  return source;
}

const registries: EgressDispatcherRegistry[] = [];

function makeRegistry(source: EgressConfigSource, logger = { warn: vi.fn(), info: vi.fn() }) {
  const registry = new EgressDispatcherRegistry(source, logger);
  registries.push(registry);
  return { registry, logger };
}

afterEach(async () => {
  while (registries.length > 0) await registries.pop()?.close();
});

describe('EgressDispatcherRegistry', () => {
  it('Staging installs one global fail-closed fetch path and restores it safely', () => {
    const direct = vi.fn() as unknown as typeof fetch;
    const guarded = vi.fn() as unknown as typeof fetch;
    const target = { fetch: direct };

    const restore = installStagingGlobalEgressFetch('staging', guarded, target);
    expect(target.fetch).toBe(guarded);
    restore();
    expect(target.fetch).toBe(direct);

    const productionRestore = installStagingGlobalEgressFetch('production', guarded, target);
    expect(target.fetch).toBe(direct);
    productionRestore();
  });

  it('未启用时一律直连', () => {
    const { registry } = makeRegistry(makeSource());
    expect(registry.resolve('https://example.com').dispatcher).toBeNull();
  });

  it('启用但地址非法时告警并直连，不抛错', () => {
    const { registry, logger } = makeRegistry(makeSource({ enabled: true, proxyUrl: 'nonsense' }));
    expect(registry.resolve('https://example.com').dispatcher).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('代理地址非法'));
  });

  it('socks 代理在 server 段不受支持，降级直连并告警', () => {
    const { registry, logger } = makeRegistry(
      makeSource({ enabled: true, proxyUrl: 'socks5://127.0.0.1:1080' }),
    );
    expect(registry.resolve('https://example.com').dispatcher).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('不支持'));
  });

  it('按域名分流：命中走代理，未命中直连', () => {
    const { registry } = makeRegistry(
      makeSource({
        enabled: true,
        proxyUrl: 'http://127.0.0.1:7890',
        matchDomains: ['openai.com'],
      }),
    );
    expect(registry.resolve('https://api.openai.com/v1').dispatcher).not.toBeNull();
    expect(registry.resolve('https://ark.cn-beijing.volces.com/api').dispatcher).toBeNull();
  });

  it('bypass 优先于 match', () => {
    const { registry } = makeRegistry(
      makeSource({
        enabled: true,
        proxyUrl: 'http://127.0.0.1:7890',
        matchDomains: ['example.com'],
        bypassDomains: ['internal.example.com'],
      }),
    );
    expect(registry.resolve('https://internal.example.com/a').dispatcher).toBeNull();
    expect(registry.resolve('https://other.example.com/a').dispatcher).not.toBeNull();
  });

  it('configVersion 变化后重建 dispatcher（改配置即生效，无需重启）', () => {
    const source = makeSource();
    const { registry } = makeRegistry(source);
    expect(registry.resolve('https://example.com').dispatcher).toBeNull();

    source.set({ enabled: true, proxyUrl: 'http://127.0.0.1:7890' });
    expect(registry.resolve('https://example.com').dispatcher).not.toBeNull();

    source.set({ enabled: false });
    expect(registry.resolve('https://example.com').dispatcher).toBeNull();
  });

  it('非法 URL 不抛错，按直连处理', () => {
    const { registry } = makeRegistry(
      makeSource({
        enabled: true,
        proxyUrl: 'http://127.0.0.1:7890',
      }),
    );
    expect(registry.resolve('::::not a url').dispatcher).toBeNull();
  });
});

describe('createEgressFetch', () => {
  function harness(
    serverCfg: Partial<EgressConfig['server']>,
    routing: 'configured' | 'web-tool' = 'configured',
  ) {
    const { registry } = makeRegistry(makeSource(serverCfg));
    const baseFetch = vi.fn(async () => new Response('direct-ok'));
    const proxyFetch = vi.fn(async () => new Response('proxy-ok'));
    const logger = { warn: vi.fn() };
    const factory = routing === 'web-tool' ? createWebToolEgressFetch : createEgressFetch;
    const egressFetch = factory(
      registry,
      logger,
      baseFetch as unknown as typeof fetch,
      proxyFetch as never,
    );
    return { egressFetch, baseFetch, proxyFetch, logger };
  }

  it('不走代理时用全局 fetch，且不附加 dispatcher', async () => {
    const { egressFetch, baseFetch, proxyFetch } = harness({});
    const response = await egressFetch('https://example.com');
    expect(await response.text()).toBe('direct-ok');
    expect(proxyFetch).not.toHaveBeenCalled();
    expect((baseFetch.mock.calls[0] as any[])[1]).toBeUndefined();
  });

  it('走代理时必须用 undici 自带 fetch，不能用全局 fetch', async () => {
    // 回归防线：Node 内置 undici 与外部 undici 包是两个实例，把外部 ProxyAgent
    // 交给全局 fetch 会以 "invalid onRequestStart method" 在几毫秒内失败。
    // 2026-07-25 生产实测踩到过，单元测试当时因 mock 了 fetch 而没能发现。
    const { egressFetch, baseFetch, proxyFetch } = harness({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
    });
    const response = await egressFetch('https://example.com');
    expect(await response.text()).toBe('proxy-ok');
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch).not.toHaveBeenCalled();
    expect((proxyFetch.mock.calls[0] as any[])[1]).toHaveProperty('dispatcher');
  });

  it('Web 工具忽略 matchDomains，把未知来源交给代理分流', async () => {
    const { egressFetch, baseFetch, proxyFetch } = harness(
      {
        enabled: true,
        proxyUrl: 'http://127.0.0.1:7890',
        matchDomains: ['openai.com'],
      },
      'web-tool',
    );

    const response = await egressFetch('https://www.pewresearch.org/report');
    expect(await response.text()).toBe('proxy-ok');
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('Web 工具仍尊重 bypassDomains 强制直连', async () => {
    const { egressFetch, baseFetch, proxyFetch } = harness(
      {
        enabled: true,
        proxyUrl: 'http://127.0.0.1:7890',
        matchDomains: ['openai.com'],
        bypassDomains: ['kaiyan.net'],
      },
      'web-tool',
    );

    const response = await egressFetch('https://api.kaiyan.net/health');
    expect(await response.text()).toBe('direct-ok');
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('Request 形态在代理或 fail-closed 策略下拒绝直连绕过', async () => {
    const { egressFetch, baseFetch, proxyFetch } = harness({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      failOpen: false,
    });
    await expect(egressFetch(new Request('https://example.com'))).rejects.toThrow(/cannot bypass/u);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('fail-open：代理链路不通时降级到全局 fetch 直连并告警', async () => {
    const { egressFetch, baseFetch, proxyFetch, logger } = harness({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      failOpen: true,
    });
    proxyFetch.mockImplementationOnce(async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:7890');
      (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      throw err;
    });

    const response = await egressFetch('https://example.com');
    expect(await response.text()).toBe('direct-ok');
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect((baseFetch.mock.calls[0] as any[])[1]).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('降级直连'));
  });

  it('fail-closed：不降级，错误如实抛出', async () => {
    const { egressFetch, baseFetch, proxyFetch } = harness({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      failOpen: false,
    });
    proxyFetch.mockImplementationOnce(async () => {
      const err = new Error('connect ECONNREFUSED');
      (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      throw err;
    });

    await expect(egressFetch('https://example.com')).rejects.toThrow(/ECONNREFUSED/);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('非传输类错误不降级——直连大概率同样失败，重试只会放大延迟', async () => {
    const { egressFetch, baseFetch, proxyFetch } = harness({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      failOpen: true,
    });
    proxyFetch.mockImplementationOnce(async () => {
      throw new TypeError('Invalid header value');
    });

    await expect(egressFetch('https://example.com')).rejects.toThrow(/Invalid header/);
    expect(baseFetch).not.toHaveBeenCalled();
  });
});

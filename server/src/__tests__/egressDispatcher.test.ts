import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EgressDispatcherRegistry,
  createEgressFetch,
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
    const { registry } = makeRegistry(makeSource({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      matchDomains: ['openai.com'],
    }));
    expect(registry.resolve('https://api.openai.com/v1').dispatcher).not.toBeNull();
    expect(registry.resolve('https://ark.cn-beijing.volces.com/api').dispatcher).toBeNull();
  });

  it('bypass 优先于 match', () => {
    const { registry } = makeRegistry(makeSource({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      matchDomains: ['example.com'],
      bypassDomains: ['internal.example.com'],
    }));
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
    const { registry } = makeRegistry(makeSource({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
    }));
    expect(registry.resolve('::::not a url').dispatcher).toBeNull();
  });
});

describe('createEgressFetch', () => {
  it('不走代理时原样透传，不附加 dispatcher', async () => {
    const { registry } = makeRegistry(makeSource());
    const baseFetch = vi.fn(async () => new Response('ok'));
    const egressFetch = createEgressFetch(registry, { warn: vi.fn() }, baseFetch as unknown as typeof fetch);

    await egressFetch('https://example.com');
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect((baseFetch.mock.calls[0] as any[])[1]).toBeUndefined();
  });

  it('走代理时附加 dispatcher', async () => {
    const { registry } = makeRegistry(makeSource({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
    }));
    const baseFetch = vi.fn(async () => new Response('ok'));
    const egressFetch = createEgressFetch(registry, { warn: vi.fn() }, baseFetch as unknown as typeof fetch);

    await egressFetch('https://example.com');
    expect((baseFetch.mock.calls[0] as any[])[1]).toHaveProperty('dispatcher');
  });

  it('fail-open：代理链路不通时降级直连并告警', async () => {
    const { registry } = makeRegistry(makeSource({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      failOpen: true,
    }));
    const logger = { warn: vi.fn() };
    let call = 0;
    const baseFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1 && init && 'dispatcher' in init) {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:7890');
        (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
        throw err;
      }
      return new Response('direct-ok');
    });
    const egressFetch = createEgressFetch(registry, logger, baseFetch as unknown as typeof fetch);

    const response = await egressFetch('https://example.com');
    expect(await response.text()).toBe('direct-ok');
    expect(baseFetch).toHaveBeenCalledTimes(2);
    // 第二次是直连：原样传回调用方给的 init（本例为 undefined），不带 dispatcher
    const retryInit = (baseFetch.mock.calls[1] as any[])[1];
    expect(retryInit === undefined || !('dispatcher' in retryInit)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('降级直连'));
  });

  it('fail-closed：不降级，错误如实抛出', async () => {
    const { registry } = makeRegistry(makeSource({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      failOpen: false,
    }));
    const baseFetch = vi.fn(async () => {
      const err = new Error('connect ECONNREFUSED');
      (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      throw err;
    });
    const egressFetch = createEgressFetch(registry, { warn: vi.fn() }, baseFetch as unknown as typeof fetch);

    await expect(egressFetch('https://example.com')).rejects.toThrow(/ECONNREFUSED/);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('非传输类错误不降级——直连大概率同样失败，重试只会放大延迟', async () => {
    const { registry } = makeRegistry(makeSource({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
      failOpen: true,
    }));
    const baseFetch = vi.fn(async () => {
      throw new TypeError('Invalid header value');
    });
    const egressFetch = createEgressFetch(registry, { warn: vi.fn() }, baseFetch as unknown as typeof fetch);

    await expect(egressFetch('https://example.com')).rejects.toThrow(/Invalid header/);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});

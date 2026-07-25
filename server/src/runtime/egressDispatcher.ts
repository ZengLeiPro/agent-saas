/**
 * server(brain) 进程的出站代理 dispatcher（2026-07-25）。
 *
 * 为什么需要它：Node 原生 fetch 不读 HTTP_PROXY 环境变量，仓库里也没有任何
 * setGlobalDispatcher/ProxyAgent，所以 WebFetch 抓境外页面在此之前是 100% 失败的。
 *
 * 为什么不用 setGlobalDispatcher：全局设置会把模型调用（火山 Ark）、OSS、钉钉、
 * 短信这些境内出站也一并绕出去——既慢，又可能触发境内服务对境外来源 IP 的风控。
 * 因此这里只提供 per-request dispatcher，由调用方（WebFetch / WebSearch）显式使用。
 *
 * fail-open：代理连不上时降级直连重试一次。多数站点直连本来就可达，让代理故障
 * 放大成全站不可用是更糟的选择。降级会打 warn 日志，便于发现代理静默失效。
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import {
  parseProxyUrl,
  shouldProxyHost,
  type EgressConfig,
  type EgressServerProxyConfig,
} from './egressPolicy.js';

/** undici 的 ProxyAgent 只支持 HTTP CONNECT 隧道，socks 需要另外的 agent 实现 */
const DISPATCHER_SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

export interface EgressConfigSource {
  getConfig(): EgressConfig;
  getConfigVersion(): number;
  /** 代理凭据 user:pass，已从 SecretVault 解出；无凭据返回 undefined */
  getProxyCredential?(): string | undefined;
}

export interface EgressDispatcherLogger {
  warn(msg: string): void;
  info?(msg: string): void;
}

interface CachedDispatcher {
  version: number;
  agent: ProxyAgent | null;
  /** 该 agent 对应的配置快照，避免每次请求重新读 store */
  serverConfig: EgressServerProxyConfig;
}

export class EgressDispatcherRegistry {
  private cached: CachedDispatcher | null = null;

  constructor(
    private readonly source: EgressConfigSource,
    private readonly logger: EgressDispatcherLogger = { warn: () => undefined },
  ) {}

  /**
   * 取当前生效的代理 dispatcher；返回 null 表示该请求应直连。
   * 按 configVersion 懒重建，配置没变时复用同一个 agent（保持连接池）。
   */
  private ensureDispatcher(): CachedDispatcher {
    const version = this.source.getConfigVersion();
    if (this.cached && this.cached.version === version) return this.cached;

    const config = this.source.getConfig();
    const serverConfig = config.server;
    const previous = this.cached;
    let agent: ProxyAgent | null = null;

    if (serverConfig.enabled) {
      const parsed = parseProxyUrl(serverConfig.proxyUrl);
      if (!parsed) {
        this.logger.warn(
          `[egress] server 段已启用但代理地址非法，本次按直连处理: ${serverConfig.proxyUrl}`,
        );
      } else if (!DISPATCHER_SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
        this.logger.warn(
          `[egress] server 段不支持 ${parsed.protocol} 代理（仅 http/https），本次按直连处理`,
        );
      } else {
        const credential = this.source.getProxyCredential?.();
        agent = new ProxyAgent({
          uri: parsed.sanitizedUrl,
          ...(credential
            ? { token: `Basic ${Buffer.from(credential).toString('base64')}` }
            : {}),
          connectTimeout: serverConfig.timeoutMs,
        });
        this.logger.info?.(
          `[egress] server 代理已就绪 ${parsed.sanitizedUrl}`
            + `（matchDomains=${serverConfig.matchDomains.length || 'all'}, failOpen=${serverConfig.failOpen}）`,
        );
      }
    }

    // 旧 agent 异步关闭，不阻塞本次请求；在途请求由 undici 自行收口
    if (previous?.agent) {
      void previous.agent.close().catch(() => undefined);
    }
    this.cached = { version, agent, serverConfig };
    return this.cached;
  }

  /** 该 URL 是否应走代理，以及走哪个 dispatcher */
  resolve(url: string | URL): { dispatcher: Dispatcher | null; failOpen: boolean } {
    const state = this.ensureDispatcher();
    if (!state.agent) return { dispatcher: null, failOpen: state.serverConfig.failOpen };
    let hostname: string;
    try {
      hostname = typeof url === 'string' ? new URL(url).hostname : url.hostname;
    } catch {
      return { dispatcher: null, failOpen: state.serverConfig.failOpen };
    }
    if (!shouldProxyHost(hostname, state.serverConfig)) {
      return { dispatcher: null, failOpen: state.serverConfig.failOpen };
    }
    return { dispatcher: state.agent, failOpen: state.serverConfig.failOpen };
  }

  /** 进程退出/测试清理 */
  async close(): Promise<void> {
    if (this.cached?.agent) {
      await this.cached.agent.close().catch(() => undefined);
    }
    this.cached = null;
  }
}

/**
 * 判断错误是否属于「代理链路本身不通」，只有这类才值得降级直连。
 * HTTP 状态码错误不在此列——那是目标站点的响应，直连大概率同样失败。
 */
function isProxyTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']
      .includes(code)
  ) {
    return true;
  }
  const message = `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}`.toLowerCase();
  return message.includes('proxy')
    || message.includes('econnrefused')
    || message.includes('connect timeout')
    || message.includes('socket hang up')
    || message.includes('fetch failed');
}

/**
 * 构造一个 egress-aware 的 fetch，签名与全局 fetch 一致，可直接作为
 * `fetchImpl` 注入 webToolProvider / searchProviders，无需改动它们的 SSRF 逻辑。
 *
 * ⚠️ 走代理时必须用 `undici` 包自带的 fetch，不能用全局 fetch：
 * Node 内置的 undici 与 node_modules 里的 `undici` 是**两个独立实例**，把外部
 * ProxyAgent 交给全局 fetch 会在内部接口校验时直接失败
 * （`TypeError: invalid onRequestStart method`），耗时仅几毫秒，极易被误判成
 * 「网络不通」。2026-07-25 生产实测：curl 经同一代理 204/192ms，全局 fetch +
 * 外部 ProxyAgent 9ms 失败，undici.fetch + 同一 ProxyAgent 204/240ms 成功。
 */
export function createEgressFetch(
  registry: EgressDispatcherRegistry,
  logger: EgressDispatcherLogger = { warn: () => undefined },
  baseFetch: typeof fetch = fetch,
  proxyFetch: typeof undiciFetch = undiciFetch,
): typeof fetch {
  return async function egressFetch(input, init) {
    // Request 形态无法安全拆成 (url, init) 交给另一个 fetch 实现（body 是流），
    // 当前调用方（WebFetch/WebSearch）只传 string|URL；遇到 Request 一律直连。
    if (input instanceof Request) return baseFetch(input, init);

    const { dispatcher, failOpen } = registry.resolve(input as string | URL);
    if (!dispatcher) return baseFetch(input, init);

    const target = typeof input === 'string' ? input : String(input);
    try {
      const response = await proxyFetch(target, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      });
      // undici 的 Response 与全局 Response 结构等价（都是 WHATWG 实现），
      // 但类型来自不同声明，调用方只用标准成员，断言安全。
      return response as unknown as Response;
    } catch (err) {
      if (!failOpen || !isProxyTransportError(err)) throw err;
      logger.warn(
        `[egress] 经代理请求失败，已降级直连重试: ${target}`
          + ` (${err instanceof Error ? err.message : String(err)})`,
      );
      return baseFetch(input, init);
    }
  } as typeof fetch;
}

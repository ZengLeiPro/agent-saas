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

import {
  ProxyAgent,
  WebSocket as UndiciWebSocket,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';

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

export type EgressWebSocket = InstanceType<typeof UndiciWebSocket>;

export type EgressWebSocketConnector = (input: {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
}) => Promise<EgressWebSocket>;

export interface GlobalFetchTarget {
  fetch: typeof fetch;
}

/**
 * Staging cannot rely on opt-in callers: install the fail-closed egress fetch
 * for every use of globalThis.fetch and return a guarded restore callback.
 */
export function installStagingGlobalEgressFetch(
  environment: string,
  guardedFetch: typeof fetch,
  target: GlobalFetchTarget = globalThis,
): () => void {
  if (environment !== 'staging') return () => undefined;
  const previous = target.fetch;
  target.fetch = guardedFetch;
  return () => {
    if (target.fetch === guardedFetch) target.fetch = previous;
  };
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
          ...(credential ? { token: `Basic ${Buffer.from(credential).toString('base64')}` } : {}),
          connectTimeout: serverConfig.timeoutMs,
        });
        this.logger.info?.(
          `[egress] server 代理已就绪 ${parsed.sanitizedUrl}` +
            `（matchDomains=${serverConfig.matchDomains.length || 'all'}, failOpen=${serverConfig.failOpen}）`,
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

  /** 按配置的 matchDomains 判断该 URL 是否走代理。 */
  resolve(url: string | URL): { dispatcher: Dispatcher | null; failOpen: boolean } {
    return this.resolveWithPolicy(url, false);
  }

  /** WebSearch/WebFetch 统一交给代理分流，仅保留 bypassDomains 强制直连。 */
  resolveWebTool(url: string | URL): { dispatcher: Dispatcher | null; failOpen: boolean } {
    return this.resolveWithPolicy(url, true);
  }

  private resolveWithPolicy(
    url: string | URL,
    proxyAll: boolean,
  ): { dispatcher: Dispatcher | null; failOpen: boolean } {
    const state = this.ensureDispatcher();
    if (!state.agent) return { dispatcher: null, failOpen: state.serverConfig.failOpen };
    let hostname: string;
    try {
      hostname = typeof url === 'string' ? new URL(url).hostname : url.hostname;
    } catch {
      return { dispatcher: null, failOpen: state.serverConfig.failOpen };
    }
    const routingConfig = proxyAll
      ? { ...state.serverConfig, matchDomains: [] }
      : state.serverConfig;
    if (!shouldProxyHost(hostname, routingConfig)) {
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
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code)
  ) {
    return true;
  }
  const message = `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}`.toLowerCase();
  return (
    message.includes('proxy') ||
    message.includes('econnrefused') ||
    message.includes('connect timeout') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed')
  );
}

/**
 * 构造按 matchDomains 分流的通用 egress fetch，供模型、OAuth 和连接器使用。
 */
export function createEgressFetch(
  registry: EgressDispatcherRegistry,
  logger: EgressDispatcherLogger = { warn: () => undefined },
  baseFetch: typeof fetch = fetch,
  proxyFetch: typeof undiciFetch = undiciFetch,
): typeof fetch {
  return createResolvedEgressFetch((url) => registry.resolve(url), logger, baseFetch, proxyFetch);
}

/**
 * WebSearch/WebFetch 的来源不可预知，不能靠静态域名白名单覆盖。
 * 代理启用后统一交给代理规则分流，同时继续尊重 bypassDomains 与 fail-open。
 */
export function createWebToolEgressFetch(
  registry: EgressDispatcherRegistry,
  logger: EgressDispatcherLogger = { warn: () => undefined },
  baseFetch: typeof fetch = fetch,
  proxyFetch: typeof undiciFetch = undiciFetch,
): typeof fetch {
  return createResolvedEgressFetch(
    (url) => registry.resolveWebTool(url),
    logger,
    baseFetch,
    proxyFetch,
  );
}

/**
 * ⚠️ 走代理时必须用 `undici` 包自带的 fetch，不能用全局 fetch：
 * Node 内置的 undici 与 node_modules 里的 `undici` 是**两个独立实例**，把外部
 * ProxyAgent 交给全局 fetch 会在内部接口校验时直接失败。
 */
function createResolvedEgressFetch(
  resolve: (url: string | URL) => { dispatcher: Dispatcher | null; failOpen: boolean },
  logger: EgressDispatcherLogger,
  baseFetch: typeof fetch,
  proxyFetch: typeof undiciFetch,
): typeof fetch {
  return async function egressFetch(input, init) {
    const requestInput = input instanceof Request;
    const targetInput = requestInput ? input.url : (input as string | URL);
    const { dispatcher, failOpen } = resolve(targetInput);

    // Request 的 body 可能是一次性流，不能安全拆给另一个 fetch 实现。只在
    // 明确 fail-open 且无需代理时允许直连；代理或 fail-closed 策略一律拒绝。
    if (requestInput) {
      if (dispatcher || !failOpen) {
        throw new Error('Request input cannot bypass a proxy or fail-closed egress policy.');
      }
      return baseFetch(input, init);
    }
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
        `[egress] 经代理请求失败，已降级直连重试: ${target}` +
          ` (${err instanceof Error ? err.message : String(err)})`,
      );
      return baseFetch(input, init);
    }
  } as typeof fetch;
}

/**
 * 构造一个遵守同一 server egress policy 的 WebSocket connector。
 *
 * undici.WebSocket 接受 Dispatcher，因此可以直接复用 HTTP/SSE 已验证的
 * ProxyAgent，不需要另建一套代理配置或绕过平台出口策略。只有配置显式
 * failOpen 且错误属于代理链路故障时，才会降级直连重试一次。
 */
export function createEgressWebSocketConnector(
  registry: EgressDispatcherRegistry,
  logger: EgressDispatcherLogger = { warn: () => undefined },
): EgressWebSocketConnector {
  return async ({ url, headers, signal, connectTimeoutMs = 15_000 }) => {
    const { dispatcher, failOpen } = registry.resolve(url);
    try {
      return await openWebSocket(url, headers, dispatcher, signal, connectTimeoutMs);
    } catch (error) {
      if (!dispatcher || !failOpen || !isProxyTransportError(error)) throw error;
      logger.warn(
        `[egress] WebSocket 经代理连接失败，已降级直连重试: ${url}` +
          ` (${error instanceof Error ? error.message : String(error)})`,
      );
      return openWebSocket(url, headers, null, signal, connectTimeoutMs);
    }
  };
}

async function openWebSocket(
  url: string,
  headers: Record<string, string>,
  dispatcher: Dispatcher | null,
  signal: AbortSignal | undefined,
  connectTimeoutMs: number,
): Promise<EgressWebSocket> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const socket = new UndiciWebSocket(url, {
    headers,
    ...(dispatcher ? { dispatcher } : {}),
  });
  socket.binaryType = 'arraybuffer';

  return new Promise<EgressWebSocket>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      if (error !== undefined) {
        try {
          socket.close();
        } catch {
          /* connecting socket may already be closed */
        }
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onOpen = () => finish();
    const onError = (event: Event) => {
      const candidate = event as Event & { error?: unknown; message?: string };
      const detail =
        candidate.error instanceof Error && candidate.error.message.trim()
          ? candidate.error
          : typeof candidate.message === 'string' && candidate.message.trim()
            ? new Error(candidate.message)
            : new Error('WebSocket connection failed before open (empty ErrorEvent)');
      finish(detail);
    };
    const onClose = (event: CloseEvent) => {
      finish(
        new Error(
          `WebSocket closed before open (code=${event.code} reason=${event.reason || 'none'})`,
        ),
      );
    };
    const onAbort = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      finish(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
    timer.unref?.();

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

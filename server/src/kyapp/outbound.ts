/**
 * WP2a 统一出站通道（规范 §6.3、§3.7、§4.6）。
 *
 * 平台主动打给定制项目的每一次请求都必须经过这里，四道闸门缺一不可：
 * 1. `validateRemoteUrl`（`agent/web/ssrf.ts`）：仅 https、拒 userinfo、解析后逐地址拒私网/环回/链路本地/元数据；
 * 2. 只允许登记 `baseUrl` 的**精确 host**——路径可变，host 不可变；
 * 3. `redirect:'manual'`：任何 3xx 都当 `upstream_unavailable`，不跟随（跟随会绕过第 1、2 道）；
 * 4. 15 秒硬超时。
 *
 * `kyApp.environment` 为 local/staging 且 `allowInsecureOutbound` 打开时，允许 http 环回地址
 * （开发与联调用；prod 由 `kyapp/config.ts` 在解析期就禁止打开该开关）。
 *
 * 出站 fetch 默认取 `globalThis.fetch`：staging 下 `installStagingGlobalEgressFetch`
 * 已把全局 fetch 替换成受管的 egress fetch（`app/runtimeStagingEgressBootstrap.ts`、
 * `app/runtimeGovernanceConnectors.ts`），因此默认值即经过 egress 通道；
 * 测试与其他装配可通过 `fetchImpl` 注入。
 */
import type { lookup as dnsLookup } from 'node:dns/promises';

import { validateRemoteUrl } from '../agent/web/ssrf.js';
import type { KyAppPlatformConfig } from './config.js';

/** 规范 §6.3：单次出站 15 秒硬超时。 */
export const KY_APP_OUTBOUND_TIMEOUT_MS = 15_000;

/** 出站失败的归类。客户面文案由上层按 code 渲染，这里的 message 只进日志。 */
export type KyAppOutboundFailure = 'blocked' | 'timeout' | 'upstream_unavailable';

export class KyAppOutboundError extends Error {
  constructor(
    message: string,
    readonly code: KyAppOutboundFailure,
  ) {
    super(message);
    this.name = 'KyAppOutboundError';
  }
}

export interface KyAppOutboundRequest {
  /** 安装实例登记的 baseUrl（host 白名单的唯一来源）。 */
  baseUrl: string;
  /** 以 `/` 开头的绝对路径，例如 `/ky/v1/events`。 */
  path: string;
  method: 'GET' | 'POST';
  /** SAT 等请求头；`X-KY-Request-Id` 由调用方给出。 */
  headers?: Readonly<Record<string, string>>;
  /** JSON 请求体；给出即自动带 `Content-Type: application/json`。 */
  jsonBody?: unknown;
  requestId: string;
}

export interface KyAppOutboundResult {
  status: number;
  /** 原始响应文本（截断到 `maxBytes`）。 */
  text: string;
  /** JSON 解析结果；解析失败为 `null`。 */
  json: unknown;
}

export interface KyAppOutboundOptions {
  config: Pick<KyAppPlatformConfig, 'environment' | 'allowInsecureOutbound'>;
  fetchImpl?: typeof fetch;
  lookup?: typeof dnsLookup;
  timeoutMs?: number;
  /** 响应体读取上限，默认 256 KB；超出即截断（不改变状态码判定）。 */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost');
}

/** 允许 http 环回：只在 local/staging 且显式打开开关时成立。 */
function allowsInsecureLoopback(options: KyAppOutboundOptions, url: URL): boolean {
  if (!options.config.allowInsecureOutbound) return false;
  if (options.config.environment === 'prod') return false;
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

export interface KyAppOutbound {
  request(input: KyAppOutboundRequest): Promise<KyAppOutboundResult>;
}

export function createKyAppOutbound(options: KyAppOutboundOptions): KyAppOutbound {
  const fetchImpl =
    options.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? KY_APP_OUTBOUND_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  async function resolveTarget(baseUrl: string, path: string): Promise<URL> {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new KyAppOutboundError(`出站路径必须是单斜杠开头的绝对路径：${path}`, 'blocked');
    }
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      throw new KyAppOutboundError('安装实例登记的 baseUrl 不是合法 URL', 'blocked');
    }
    const target = new URL(`${base.origin}${path}`);
    // 精确 host 白名单：即使 path 里塞了 `@host` 之类的花招，origin 也已经先固定住。
    if (target.host !== base.host) {
      throw new KyAppOutboundError('出站目标 host 与登记的 baseUrl 不一致', 'blocked');
    }
    if (allowsInsecureLoopback(options, target)) return target;
    if (target.protocol !== 'https:') {
      throw new KyAppOutboundError('出站只允许 https（本机 http 需显式开启开关）', 'blocked');
    }
    try {
      await validateRemoteUrl(target, {
        ...(options.lookup ? { lookup: options.lookup } : {}),
        egress: { allowedHosts: [target.hostname] },
      });
    } catch (error) {
      throw new KyAppOutboundError(
        `出站目标未通过安全校验：${error instanceof Error ? error.message : String(error)}`,
        'blocked',
      );
    }
    return target;
  }

  return {
    async request(input: KyAppOutboundRequest): Promise<KyAppOutboundResult> {
      const target = await resolveTarget(input.baseUrl, input.path);
      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-ky-request-id': input.requestId,
        ...(input.headers ?? {}),
      };
      if (input.jsonBody !== undefined) headers['content-type'] = 'application/json';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(target, {
          method: input.method,
          headers,
          redirect: 'manual',
          signal: controller.signal,
          ...(input.jsonBody === undefined ? {} : { body: JSON.stringify(input.jsonBody) }),
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        throw new KyAppOutboundError(
          aborted
            ? `出站请求超过 ${timeoutMs} 毫秒`
            : `出站请求失败：${error instanceof Error ? error.message : String(error)}`,
          aborted ? 'timeout' : 'upstream_unavailable',
        );
      } finally {
        clearTimeout(timer);
      }

      // `redirect:'manual'` 下 3xx 会原样返回；跟随重定向会绕过 host 白名单与私网校验，一律拒绝。
      if (response.status >= 300 && response.status < 400) {
        throw new KyAppOutboundError(
          `出站目标返回重定向 ${response.status}，契约不允许跟随`,
          'upstream_unavailable',
        );
      }
      const text = (await response.text().catch(() => '')).slice(0, maxBytes);
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, text, json };
    },
  };
}

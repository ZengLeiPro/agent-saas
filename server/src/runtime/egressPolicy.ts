/**
 * 网络出口（代理 / 镜像源）共享策略层。
 *
 * 这个模块被 server 与 acs-orchestrator 两个进程共同引用（orchestrator 已有
 * `server/runtime/networkPolicy.js` 的先例），因此只放纯函数与常量，不引入
 * 任何 express / zod / fs 依赖。
 *
 * 设计要点：
 * 1. 分流智能放在代理服务端（mihomo 一类的规则引擎按 GEOIP/域名决定 DIRECT 还是
 *    走境外节点），客户端只负责「发给代理」或「不发给代理」。因此 noProxy 只列
 *    必须绕过代理的内网地址，不维护境内公网域名白名单——那是维护地狱。
 * 2. Sandbox 侧环境变量必须大小写各写一份：curl/wget/git 认小写，Go 二进制
 *    （gh/aliyun/dws/lark-cli）认大写，Chromium 在无 GNOME/KDE 的容器里只认小写。
 * 3. 代理主机若是 IP，会被自动加进 TrafficPolicy 的 allow 列表——否则
 *    public-egress 模式下 `172.16.0.0/12` 的 deny 规则会把代理本身挡掉。
 */

import { isIP } from 'node:net';

export interface EgressServerProxyConfig {
  enabled: boolean;
  proxyUrl: string;
  matchDomains: string[];
  bypassDomains: string[];
  timeoutMs: number;
  failOpen: boolean;
}

export interface EgressSandboxProxyConfig {
  enabled: boolean;
  proxyUrl: string;
  noProxy: string[];
}

export interface EgressPackageMirrorsConfig {
  enabled: boolean;
  pipIndexUrl: string;
  pipTrustedHost: string;
  npmRegistry: string;
}

export interface EgressConfig {
  server: EgressServerProxyConfig;
  sandbox: EgressSandboxProxyConfig;
  packageMirrors: EgressPackageMirrorsConfig;
}

/**
 * Sandbox 侧强制绕过代理的地址。管理员配置的 noProxy 会与这份合并。
 * 少一条都可能让容器起不来或 DNS 断掉，因此不做成可删项。
 */
export const FORCED_SANDBOX_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  // 阿里云 VPC DNS：Sandbox 的 resolv.conf 直接指向这两个地址
  '100.100.2.136',
  '100.100.2.138',
  // metadata 服务：TrafficPolicy 已 deny，这里避免再经代理转发一次
  '100.100.100.200',
  // VPC 内网服务（ACR / NAS / OSS 内网端点）走代理必失败
  '.aliyuncs.com',
  // K8s 集群内部域名
  '.svc',
  '.svc.cluster.local',
  '.cluster.local',
  // 内网段（curl/Go 支持 CIDR 形式的 no_proxy）
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

export const DEFAULT_PIP_INDEX_URL = 'https://mirrors.cloud.aliyuncs.com/pypi/simple/';
export const DEFAULT_PIP_TRUSTED_HOST = 'mirrors.cloud.aliyuncs.com';
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com';

export const DEFAULT_EGRESS_CONFIG: EgressConfig = Object.freeze({
  server: Object.freeze({
    enabled: false,
    proxyUrl: '',
    matchDomains: [],
    bypassDomains: [],
    timeoutMs: 20_000,
    failOpen: true,
  }),
  sandbox: Object.freeze({
    enabled: false,
    proxyUrl: '',
    noProxy: [],
  }),
  packageMirrors: Object.freeze({
    enabled: false,
    pipIndexUrl: DEFAULT_PIP_INDEX_URL,
    pipTrustedHost: DEFAULT_PIP_TRUSTED_HOST,
    npmRegistry: DEFAULT_NPM_REGISTRY,
  }),
}) as EgressConfig;

const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:', 'socks:']);

export interface ParsedProxyUrl {
  protocol: string;
  hostname: string;
  port: string;
  /** 不含凭据的规范化 URL，用于日志与注入 env */
  sanitizedUrl: string;
}

/**
 * 解析并校验代理地址。返回 null 表示非法——调用方据此拒绝保存或跳过注入，
 * 不要把非法值继续往 Pod env / dispatcher 里传。
 */
export function parseProxyUrl(raw: string): ParsedProxyUrl | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname) return null;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    sanitizedUrl: `${url.protocol}//${url.hostname}:${port}`,
  };
}

/**
 * 代理主机对应的 /32 CIDR，供 TrafficPolicy 自动放行。
 * 主机是域名时返回 null——域名形式的代理需要管理员自行在网络策略里放行，
 * 因为 TrafficPolicy 的 fqdn peer 与 deny CIDR 的优先级组合无法在此确定。
 */
export function proxyHostCidr(proxyUrl: string): string | null {
  const parsed = parseProxyUrl(proxyUrl);
  if (!parsed) return null;
  return isIP(parsed.hostname) === 4 ? `${parsed.hostname}/32` : null;
}

/** 把用户配置的 noProxy 与强制项合并去重，保持强制项在前 */
export function buildNoProxyList(extra: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...FORCED_SANDBOX_NO_PROXY, ...extra]) {
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export interface SandboxEnvEntry {
  name: string;
  value: string;
}

/**
 * Sandbox Pod 的代理环境变量。大小写各一份是刚需，不是冗余：
 * Chromium 在容器里只读小写，Go 二进制优先读大写。
 */
export function buildSandboxProxyEnv(config: EgressSandboxProxyConfig): SandboxEnvEntry[] {
  if (!config.enabled) return [];
  const parsed = parseProxyUrl(config.proxyUrl);
  if (!parsed) return [];
  const proxy = parsed.sanitizedUrl;
  const noProxy = buildNoProxyList(config.noProxy).join(',');
  return [
    { name: 'HTTP_PROXY', value: proxy },
    { name: 'http_proxy', value: proxy },
    { name: 'HTTPS_PROXY', value: proxy },
    { name: 'https_proxy', value: proxy },
    { name: 'NO_PROXY', value: noProxy },
    { name: 'no_proxy', value: noProxy },
  ];
}

/** pip / npm 国内镜像源环境变量；与代理无关，可单独开启 */
export function buildPackageMirrorEnv(config: EgressPackageMirrorsConfig): SandboxEnvEntry[] {
  if (!config.enabled) return [];
  const entries: SandboxEnvEntry[] = [];
  const pipIndexUrl = config.pipIndexUrl.trim();
  const pipTrustedHost = config.pipTrustedHost.trim();
  const npmRegistry = config.npmRegistry.trim();
  if (pipIndexUrl) entries.push({ name: 'PIP_INDEX_URL', value: pipIndexUrl });
  if (pipTrustedHost) entries.push({ name: 'PIP_TRUSTED_HOST', value: pipTrustedHost });
  if (npmRegistry) entries.push({ name: 'NPM_CONFIG_REGISTRY', value: npmRegistry });
  return entries;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\./, '');
}

/** 后缀匹配：example.com 命中 example.com 与 a.example.com，但不命中 notexample.com */
function domainMatches(host: string, pattern: string): boolean {
  const target = normalizeDomain(pattern);
  if (!target) return false;
  const normalizedHost = host.trim().toLowerCase();
  return normalizedHost === target || normalizedHost.endsWith(`.${target}`);
}

/**
 * server 侧判断某个 host 是否该走代理。
 * bypass 优先于 match；matchDomains 为空表示「全部走代理」。
 */
export function shouldProxyHost(host: string, config: EgressServerProxyConfig): boolean {
  if (!config.enabled) return false;
  if (!parseProxyUrl(config.proxyUrl)) return false;
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost) return false;
  if (config.bypassDomains.some((pattern) => domainMatches(normalizedHost, pattern))) return false;
  if (config.matchDomains.length === 0) return true;
  return config.matchDomains.some((pattern) => domainMatches(normalizedHost, pattern));
}

/** 配置指纹：Pod env 是否需要随配置变化而重建容器时用来比对 */
export function egressSandboxFingerprint(
  sandbox: EgressSandboxProxyConfig,
  mirrors: EgressPackageMirrorsConfig,
): string {
  const proxyEnv = buildSandboxProxyEnv(sandbox);
  const mirrorEnv = buildPackageMirrorEnv(mirrors);
  return [...proxyEnv, ...mirrorEnv]
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('|');
}

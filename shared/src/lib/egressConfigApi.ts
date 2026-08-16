import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';

/**
 * 网络出口（代理 / 镜像源）配置管理 API（platform-admin「网络出口」页）。
 * 对应 server GET/PUT /api/admin/egress-config（requirePlatformAdmin）。
 *
 * 三段作用域互相独立，可分别开关：
 *   - server：brain 进程的 WebFetch / WebSearch 出站是否走代理（undici ProxyAgent，
 *     按域名匹配，绝不动全局 dispatcher，因此模型调用/火山/OSS/钉钉不受影响）。
 *   - sandbox：ACS Sandbox Pod 注入 HTTP_PROXY 等环境变量；分流由代理服务端的
 *     规则引擎负责，noProxy 只列必须绕过代理的内网地址。
 *   - packageMirrors：pip / npm 国内镜像源，与代理无关，境内直连即可加速。
 */

export interface EgressServerProxyConfig {
  enabled: boolean;
  /** 代理地址，如 http://172.16.177.77:7890；支持 http/https/socks5 */
  proxyUrl: string;
  /**
   * 模型、OAuth 和连接器等通用请求的代理域名列表（后缀匹配）。
   * WebSearch/WebFetch 来源不可预知，启用代理后不受此列表限制。
   */
  matchDomains: string[];
  /** 永不走代理的域名；WebSearch/WebFetch 同样尊重该列表 */
  bypassDomains: string[];
  /** 单请求经代理的超时（毫秒） */
  timeoutMs: number;
  /**
   * 代理不可用时是否降级直连。true=fail-open（多数站点直连本就可达，
   * 避免代理故障放大成全站不可用）；false=fail-closed，直接报错。
   */
  failOpen: boolean;
}

export interface EgressSandboxProxyConfig {
  enabled: boolean;
  /** 代理地址；注入 Pod env 时会同时写大小写两份（Chromium/curl 只认小写） */
  proxyUrl: string;
  /** NO_PROXY 列表；VPC DNS 与 localhost 由服务端强制补齐，无需手填 */
  noProxy: string[];
}

export interface EgressPackageMirrorsConfig {
  enabled: boolean;
  /** pip 索引地址，如 https://mirrors.aliyun.com/pypi/simple/ */
  pipIndexUrl: string;
  /** pip trusted-host，通常是 pipIndexUrl 的主机名 */
  pipTrustedHost: string;
  /** npm registry，如 https://registry.npmmirror.com */
  npmRegistry: string;
}

export interface EgressConfig {
  server: EgressServerProxyConfig;
  sandbox: EgressSandboxProxyConfig;
  packageMirrors: EgressPackageMirrorsConfig;
}

/** orchestrator 下发结果；配置已存但下发失败时 ok=false，不阻塞保存 */
export interface EgressSandboxSyncState {
  ok: boolean;
  /** 失败原因；ok=true 时为 null */
  error: string | null;
  syncedAt: string | null;
}

export interface EgressConfigAdminView {
  config: EgressConfig;
  /** 代理凭据是否已配置（永不回显明文） */
  proxyCredentialConfigured: boolean;
  /**
   * Sandbox 段下发到 acs-orchestrator 的最近一次结果。
   * 注意：Pod env 在容器创建时固化，改配置只对**新建容器**生效，
   * 已运行的容器需等待自然 pause/重建。
   */
  sandboxSync: EgressSandboxSyncState;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UpdateEgressConfigRequest {
  config: EgressConfig;
  /**
   * 代理凭据 user:pass：undefined = 不改动现值；null = 清除；
   * 非空字符串 = 写入 secretVault。
   */
  proxyCredential?: string | null;
}

export interface EgressProbeResult {
  /** 探测目标 URL */
  target: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface EgressProbeResponse {
  /** 经代理访问境外站点 */
  viaProxy: EgressProbeResult;
  /** 直连同一站点，用于对比确认代理确实起了作用 */
  direct: EgressProbeResult;
}

const API_BASE = '/api/admin/egress-config';

export async function fetchEgressConfig(): Promise<EgressConfigAdminView> {
  return parseJsonResponse<EgressConfigAdminView>(
    await authFetch(API_BASE),
    '网络出口',
  );
}

export async function updateEgressConfig(
  payload: UpdateEgressConfigRequest,
): Promise<EgressConfigAdminView> {
  return parseJsonResponse<EgressConfigAdminView>(
    await authFetch(API_BASE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    '网络出口',
  );
}

/** 用当前草稿里的代理地址做一次连通性探测（不落盘） */
export async function probeEgressProxy(payload: {
  proxyUrl: string;
  timeoutMs?: number;
}): Promise<EgressProbeResponse> {
  return parseJsonResponse<EgressProbeResponse>(
    await authFetch(`${API_BASE}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    '网络出口探测',
  );
}

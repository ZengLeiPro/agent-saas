/** Hono 参考适配器的公共类型：请求身份、路由配置与 Hono 变量表。 */
import type {
  HealthLiveResponse,
  LocalAct,
  Manifest,
  MeResponse,
  SatAct,
} from '@kaiyan/ky-app-contract';

import type { AttestationIssuer } from '../local/attest.js';
import type { BreakGlass } from '../breakGlass/service.js';
import type { CapabilityRuntime } from '../capabilities/define.js';
import type { DirectoryStalenessGate } from '../directory/staleness.js';
import type { EventsHandler } from '../events/handler.js';
import type { JwksClient } from '../jwks/client.js';
import type { JtiStore } from '../sat/jtiStore.js';
import type { KyAppConfig } from '../config/index.js';
import type { SecurityHeadersOptions } from './securityHeaders.js';
import type { LocalKeyRing } from '../local/keys.js';
import type { VerifiedIdentity } from '../sat/verify.js';
import type { VerifiedLocalIdentity } from '../local/token.js';

/** 统一的请求身份：SAT 与 Local Token 两条来源收敛成同一形态。 */
export interface KyRequestIdentity {
  act: SatAct | LocalAct;
  sub?: string;
  tadm: boolean;
  pfx: string[];
  /** SAT 来源时有值。 */
  sat?: VerifiedIdentity;
  /** Local Token 来源时有值。 */
  local?: VerifiedLocalIdentity;
}

/** 结构化日志条目（§8.5：`X-KY-Request-Id` 结构化日志 30 天）。 */
export interface KyLogEntry {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  act?: string;
  sub?: string;
  errorCode?: string;
}

export interface KyAppRouterHealth {
  appVersion: string;
  /** 发版期间返回 `maintenance`（§8.3）。 */
  maintenance?: () => boolean;
  etaMinutes?: () => number | undefined;
  db?: () => Promise<boolean> | boolean;
  live?: () => HealthLiveResponse;
}

/** `/ky/v1/test/*`（仅 `KY_ENV=test`，§3.8）。 */
export interface KyAppTestHooks {
  /** 预置测试用户角色（§9.3-7）。 */
  provision?: (input: unknown) => Promise<unknown>;
  /** 驱动兜底模式（不需要恢复因子）。 */
  breakGlass?: (input: unknown) => Promise<unknown>;
  /**
   * 驱动组织目录消费（§9.3-12）：一致性测试需要在外部触发一轮 `sync()`、
   * 读回本地目录快照与陈旧度。没有这个钩子就只能靠轮询等，测试无法确定。
   */
  directory?: (input: unknown) => Promise<unknown>;
}

export interface KyAppRouterConfig {
  config: KyAppConfig;
  manifest: Manifest;
  /** 缺省由 manifest 现算。 */
  manifestDigest?: string;
  jwks?: JwksClient;
  jtiStore: JtiStore;
  capabilities: CapabilityRuntime;
  events: EventsHandler;
  localKeys?: LocalKeyRing;
  attestation?: AttestationIssuer;
  breakGlass?: BreakGlass;
  /** 目录陈旧度门禁（§3.4）；缺省视为不设门禁。 */
  directoryStaleness?: () => Promise<DirectoryStalenessGate>;
  /** 组装 `/me`。 */
  buildMe: (identity: KyRequestIdentity) => Promise<MeResponse>;
  /** 每个业务 API 响应的 `X-KY-Perm-Version`（§3.4、§9.2）。 */
  permVersion: (identity: KyRequestIdentity) => Promise<string> | string;
  /** 目录消费位点，用于 `health/ready`。 */
  directorySync?: () => Promise<{ checkpoint: number; ageSeconds: number }>;
  health: KyAppRouterHealth;
  /**
   * §5.1 响应头的覆盖项。生产不要动；本地 / 一致性测试需要把 mock 壳的 origin
   * 加进 `frame-ancestors`，否则跨源 iframe 加载不了。
   */
  securityHeaders?: SecurityHeadersOptions;
  testHooks?: KyAppTestHooks;
  /** 取客户端 IP（限速用）；缺省读 `x-forwarded-for` / `x-real-ip`。 */
  clientIp?: (headers: Headers) => string | undefined;
  onLog?: (entry: KyLogEntry) => void;
  now?: () => number;
}

/** Hono 的 `Variables` 声明，供应用侧 `new Hono<{ Variables: KyAppVariables }>()` 复用。 */
export interface KyAppVariables {
  kyRequestId: string;
  kyIdentity?: KyRequestIdentity;
}

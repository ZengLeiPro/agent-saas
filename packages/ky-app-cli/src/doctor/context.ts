/**
 * doctor 的运行上下文：mock 壳 + 两个被测项目进程 + PG，以及各章共用的签名 / 请求帮手。
 *
 * 一切外部依赖都在这里装配好，章节模块只写断言。
 */
import { randomBytes } from 'node:crypto';

import { aph as computeAph, type ConformanceFixture, type Manifest } from '@kaiyan/ky-app-contract';

import { startApp, type AppInstance } from '../harness/appProcess.js';
import { call, newRequestId, type CallInput, type CallResult } from '../harness/http.js';
import type { PgHandle } from '../harness/pg.js';
import type { Reporter } from '../harness/report.js';
import {
  agentClaims,
  platformClaims,
  userClaims,
  type AgentClaimOptions,
  type ClaimOverrides,
  type ClaimTime,
} from '../mockShell/sat.js';
import type { MockShell } from '../mockShell/server.js';
import type { BrowserMode } from '../types.js';

export interface DoctorEnv extends Record<string, string> {
  KY_ENV: string;
  KY_SYSTEM_ID: string;
  KY_TENANT_ID: string;
  KY_INSTALLATION_ID: string;
  KY_ORIGIN: string;
  KY_SERVICE_CREDENTIAL: string;
  KY_INSTALLATION_KEY: string;
  KY_INSTALLATION_KEY_VERSION: string;
  KY_JWKS_URL: string;
  KY_LOCAL_LOGIN_ENABLED: string;
  KY_SHELL_ORIGIN: string;
  KY_DIRECTORY_URL: string;
  DATABASE_URL: string;
}

export interface DoctorContextInit {
  projectDir: string;
  manifest: Manifest;
  manifestDigest: string;
  conformance: ConformanceFixture;
  shell: MockShell;
  app: AppInstance;
  secondApp: AppInstance | null;
  pg: PgHandle | null;
  reporter: Reporter;
  browserMode: BrowserMode;
  env: DoctorEnv;
  appPort: number;
  log: (line: string) => void;
}

export type UserOptions = { sub?: string; tadm?: boolean; name?: string } & ClaimTime;

export class DoctorContext {
  readonly projectDir: string;
  readonly manifest: Manifest;
  readonly manifestDigest: string;
  readonly conformance: ConformanceFixture;
  readonly shell: MockShell;
  readonly secondApp: AppInstance | null;
  readonly pg: PgHandle | null;
  readonly reporter: Reporter;
  readonly browserMode: BrowserMode;
  readonly env: DoctorEnv;
  readonly log: (line: string) => void;
  private readonly appPort: number;
  app: AppInstance;
  /** §3.7 安装状态事件的单调 `stateVersion`：只接受本地 +1，全程共用一个计数器。 */
  private stateVersion = 0;

  constructor(init: DoctorContextInit) {
    this.projectDir = init.projectDir;
    this.manifest = init.manifest;
    this.manifestDigest = init.manifestDigest;
    this.conformance = init.conformance;
    this.shell = init.shell;
    this.app = init.app;
    this.secondApp = init.secondApp;
    this.pg = init.pg;
    this.reporter = init.reporter;
    this.browserMode = init.browserMode;
    this.env = init.env;
    this.appPort = init.appPort;
    this.log = init.log;
  }

  get baseUrl(): string {
    return this.app.baseUrl;
  }

  // ---- 签名帮手 ----

  async signUser(options: UserOptions = {}, overrides: ClaimOverrides = {}): Promise<string> {
    return this.shell.signer.sign(userClaims(this.shell.app, options, overrides));
  }

  async signAgent(options: AgentClaimOptions, overrides: ClaimOverrides = {}): Promise<string> {
    return this.shell.signer.sign(agentClaims(this.shell.app, options, overrides));
  }

  async signPlatform(
    options: { rid: string; dig?: string } & ClaimTime,
    overrides: ClaimOverrides = {},
  ): Promise<string> {
    return this.shell.signer.sign(platformClaims(this.shell.app, options, overrides));
  }

  /** §4.3 确认绑定用的 `aph`。 */
  aph(cap: string, input: Record<string, unknown>): string {
    return computeAph({ cap, input });
  }

  // ---- 请求帮手 ----

  async call(input: CallInput): Promise<CallResult> {
    return call(this.app.baseUrl, input);
  }

  /** 以 `act=user` 打一个端点。 */
  async callAsUser(
    input: CallInput,
    user: UserOptions = {},
    overrides: ClaimOverrides = {},
  ): Promise<CallResult> {
    return this.call({ ...input, token: await this.signUser(user, overrides) });
  }

  /** 以 `act=platform` 打一个端点（自动对齐 `rid` 与 `X-KY-Request-Id`）。 */
  async callAsPlatform(input: CallInput, overrides: ClaimOverrides = {}): Promise<CallResult> {
    const requestId = input.requestId ?? newRequestId('plat');
    const token = await this.signPlatform({ rid: requestId }, overrides);
    return this.call({ ...input, token, requestId });
  }

  /** 以 `act=agent` 打一个能力端点。 */
  async callAsAgent(
    input: CallInput,
    claims: Omit<AgentClaimOptions, 'rid'> & { rid?: string },
    overrides: ClaimOverrides = {},
  ): Promise<CallResult> {
    const requestId = input.requestId ?? claims.rid ?? newRequestId('agent');
    const token = await this.signAgent({ ...claims, rid: requestId }, overrides);
    return this.call({ ...input, token, requestId });
  }

  /** 调用一个能力（自动带 `X-KY-Idempotency-Key = lcid`）。 */
  async invokeCapability(options: {
    capabilityId: string;
    input: Record<string, unknown>;
    lcid?: string;
    sub?: string;
    tadm?: boolean;
    approval?: boolean;
    /** 覆盖幂等键（负向用例）。 */
    idempotencyKey?: string | null;
    claimOverrides?: ClaimOverrides;
    /** 覆盖 `aph`（负向用例）。 */
    aphOverride?: string;
    aprOverride?: string;
  }): Promise<CallResult> {
    const lcid = options.lcid ?? `lc_${randomBytes(6).toString('hex')}`;
    const capability = this.manifest.capabilities.find((item) => item.id === options.capabilityId);
    const needsApproval = options.approval ?? capability?.approval === 'required';
    const headers: Record<string, string> = {};
    const idempotencyKey = options.idempotencyKey === undefined ? lcid : options.idempotencyKey;
    if (idempotencyKey !== null) headers['X-KY-Idempotency-Key'] = idempotencyKey;
    return this.callAsAgent(
      {
        method: 'POST',
        path: `/ky/v1/capabilities/${encodeURIComponent(options.capabilityId)}`,
        body: { input: options.input },
        headers,
      },
      {
        cap: options.capabilityId,
        lcid,
        ...(options.sub === undefined ? {} : { sub: options.sub }),
        ...(options.tadm === undefined ? {} : { tadm: options.tadm }),
        ...(needsApproval
          ? {
              apr: options.aprOverride ?? `apv_${lcid}`,
              aph: options.aphOverride ?? this.aph(options.capabilityId, options.input),
            }
          : {}),
      },
      options.claimOverrides ?? {},
    );
  }

  // ---- `/ky/v1/test/*` 驱动 ----

  async testHook(
    name: 'provision' | 'break-glass' | 'clock' | 'directory',
    body: unknown,
  ): Promise<CallResult> {
    return this.call({ method: 'POST', path: `/ky/v1/test/${name}`, body });
  }

  /** 设置时钟偏移（毫秒）；用完记得归零。 */
  async setClockOffset(offsetMs: number): Promise<void> {
    const result = await this.testHook('clock', { offsetMs });
    if (result.status !== 200) {
      throw new Error(
        `/ky/v1/test/clock 失败：HTTP ${String(result.status)} ${result.text.slice(0, 200)}`,
      );
    }
  }

  /** 重启被测进程（§9.3-4 / §9.3-6 的「存储重启」）。 */
  async restartApp(): Promise<void> {
    await this.app.stop();
    this.app = await startApp({
      projectDir: this.projectDir,
      port: this.appPort,
      env: this.env,
      log: this.log,
    });
  }

  /** 取下一个 `stateVersion`（本地 +1）。 */
  nextStateVersion(): number {
    this.stateVersion += 1;
    return this.stateVersion;
  }

  /** 当前 `stateVersion`（不自增）。 */
  currentStateVersion(): number {
    return this.stateVersion;
  }

  /** 发一条平台事件（`act=platform`）。 */
  async sendEvent(event: Record<string, unknown>): Promise<CallResult> {
    return this.callAsPlatform({ method: 'POST', path: '/ky/v1/events', body: event });
  }

  /** manifest 里某一类风险等级的能力。 */
  capabilitiesOf(riskLevel: 'read_only' | 'external_write'): Manifest['capabilities'] {
    return this.manifest.capabilities.filter((item) => item.riskLevel === riskLevel);
  }
}

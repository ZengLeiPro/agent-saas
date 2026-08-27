import { deriveSandboxScopeId, deriveWorkspaceMountSubPath, type TenantRemoteHandDispatchConfig } from './rawRuntimeRunDispatch.js';
import { selectTenantRemoteHandsForRegistration, type TenantRemoteHandAuthTokenResolver } from './tenantRemoteHandResolver.js';
import type { SessionCatalog } from './sessionCatalog.js';
import type { HandStore } from './handStore.js';
import { applySandboxProfileResources, isSandboxProfile, sandboxResourcesFromHand } from './sandboxProfile.js';

/**
 * Sandbox 预热服务（2026-07-31 冷启动治理批次）。
 *
 * 背景：ACS Sandbox 冷启动（create/重建）生产 P50 33-77s，全部落在 Agent 首个
 * 工具调用上串行等待。dispatch 收到消息时已有 fire-and-forget provision 预热，
 * 但提前量只有 LLM 首轮思考时间（5-20s），盖不住冷启动。本服务在「会话输入框
 * 首次产生有效输入」时调 orchestrator `POST /warmup`（立即 202，后台
 * ensureRunning），预热与用户继续输入+LLM 首轮并行，避免只浏览会话也创建 Sandbox。
 *
 * 安全边界：
 * - 纯旁路优化：所有失败仅记日志，绝不影响用户输入与正式执行链路；
 * - 只预热 sessionCatalog 已有 record 的会话（workspaceId/cwd 取 dispatch 写入的
 *   真实值，推导函数与 dispatch 同源，保证预热的是同一个 Sandbox scope）；
 *   record 不存在（全新会话）直接放弃，绝不自行推导身份→workspace 映射；
 * - per-scope 节流（默认 60s），配合 orchestrator 侧 ensureRunning 同名合流，
 *   高频打开会话页不产生 kubectl 压力。
 */

export interface SandboxWarmupLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SandboxWarmupServiceOptions {
  agentCwd: string;
  sessionCatalog: Pick<SessionCatalog, 'get'>;
  handStore?: Pick<HandStore, 'get'>;
  /** 与 dispatch 同源的 tenant remote hands 配置（延迟求值，支持热更新）。 */
  tenantRemoteHands: () => TenantRemoteHandDispatchConfig[] | undefined;
  tenantRemoteHandResolver: TenantRemoteHandAuthTokenResolver;
  logger?: SandboxWarmupLogger;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  /** per-scope 节流窗口，默认 60s。 */
  throttleMs?: number;
  /** warmup HTTP 超时，默认 5s（orchestrator 秒回 202，超时即视为失败记日志）。 */
  requestTimeoutMs?: number;
  isExecutionEnabled?: () => boolean | Promise<boolean>;
}

const DEFAULT_THROTTLE_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const THROTTLE_MAP_MAX_ENTRIES = 2_000;

function resourcesForSandboxProfile(record: { sandboxProfile?: unknown }): { cpu: string; memoryMb: number } | undefined {
  if (!isSandboxProfile(record.sandboxProfile)) return undefined;
  const resources = applySandboxProfileResources(undefined, record.sandboxProfile).resources;
  return resources?.cpu && resources.memoryMb
    ? { cpu: resources.cpu, memoryMb: resources.memoryMb }
    : undefined;
}

export class SandboxWarmupService {
  private readonly lastFiredAtByScope = new Map<string, number>();
  private readonly throttleMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SandboxWarmupServiceOptions) {
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * fire-and-forget：同步返回，后台完成查 record → 选 hand → POST /warmup。
   * 任何异常都被吞掉并记日志。
   */
  fireForSession(sessionId: string): void {
    if (!sessionId || typeof sessionId !== 'string') return;
    void this.fireForSessionAsync(sessionId).catch((err) => {
      this.options.logger?.warn(
        `sandbox_warmup_fire_failed sessionId=${sessionId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** 供测试与需要等待结果的调用方使用；正常业务路径用 fireForSession。 */
  async fireForSessionAsync(sessionId: string): Promise<'fired' | 'skipped'> {
    if (this.options.isExecutionEnabled && !await this.options.isExecutionEnabled()) return 'skipped';
    const record = await this.options.sessionCatalog.get(sessionId);
    if (!record) return 'skipped';
    if (record.kind === 'subagent') return 'skipped';

    const entry = this.selectAcsHand({
      userId: record.userId,
      username: record.username,
      userTenantId: record.tenantId,
    });
    if (!entry) return 'skipped';

    const workspaceId = record.workspaceId ?? sessionId;
    const mountSubPath = entry.recipe?.mountSubPath
      ?? deriveWorkspaceMountSubPath({ agentCwd: this.options.agentCwd, cwd: record.cwd });
    // 预热只对顶层会话触发（上方已 `record.kind === 'subagent'` 提前返回），
    // 故顶层组键＝该会话自身 sessionId，与 dispatch 路径算出的 scope 一致，
    // 保证预热的正是这个会话组稍后真正要用的那个 pod。
    const sandboxScopeId = entry.recipe?.sandboxScopeId
      ?? deriveSandboxScopeId({ workspaceId, mountSubPath, topLevelSessionId: sessionId });

    // 已注册 hand 的 recipe 是 Environment Template 合并后的最终事实；首次注册前回退会话 profile。
    const registeredHand = await this.options.handStore?.get(`${sessionId}:server-remote`);
    const resources = sandboxResourcesFromHand(registeredHand) ?? resourcesForSandboxProfile(record);
    const scopeKey = `${entry.id}:${sandboxScopeId}`;
    const now = Date.now();
    const lastFiredAt = this.lastFiredAtByScope.get(scopeKey);
    if (lastFiredAt !== undefined && now - lastFiredAt < this.throttleMs) return 'skipped';
    this.rememberFired(scopeKey, now);

    const resolved = await this.options.tenantRemoteHandResolver.resolveForRegister(entry);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${resolved.baseUrl.replace(/\/$/, '')}/warmup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${resolved.authToken}`,
        },
        body: JSON.stringify({
          workspaceId,
          sessionId,
          ...(sandboxScopeId ? { sandboxScopeId } : {}),
          ...(mountSubPath ? { mountSubPath } : {}),
          ...(resources ? { resources } : {}),
        }),
        signal: controller.signal,
      });
      if (response.status !== 202) {
        const text = await response.text().catch(() => '');
        this.options.logger?.warn(
          `sandbox_warmup_rejected sessionId=${sessionId} hand=${entry.id} http=${response.status} body=${text.slice(0, 200)}`,
        );
        return 'skipped';
      }
      this.options.logger?.info(`sandbox_warmup_fired sessionId=${sessionId} hand=${entry.id} scope=${sandboxScopeId}`);
      return 'fired';
    } finally {
      clearTimeout(timer);
    }
  }

  private selectAcsHand(identity: { userId?: string; username?: string; userTenantId?: string }): TenantRemoteHandDispatchConfig | undefined {
    const eligible = selectTenantRemoteHandsForRegistration(this.options.tenantRemoteHands(), identity);
    return eligible.find((hand) => hand.id === 'agent-saas-acs') ?? eligible.find((hand) => /acs/i.test(hand.id));
  }

  private rememberFired(scopeKey: string, now: number): void {
    // 简单容量兜底：超限整体清空（节流失效的代价只是多打几次幂等 warmup）。
    if (this.lastFiredAtByScope.size >= THROTTLE_MAP_MAX_ENTRIES) this.lastFiredAtByScope.clear();
    this.lastFiredAtByScope.set(scopeKey, now);
  }
}

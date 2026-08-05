/**
 * Cron 任务执行器
 */
import * as fs from "node:fs/promises";
import { getTranscriptPath } from "../data/transcripts/store.js";
import { updateSessionMeta } from "../data/transcripts/meta.js";
import { resolveUserCwd, ensureUserWorkspace } from "../workspace/resolver.js";
import type { ResolvedModel } from "../app/models.js";
import type { SkillConfigStore } from "../data/skills/store.js";
import type { SkillMaterializationCoordinator } from "../workspace/materialization/types.js";
import type { UserPreferences } from "../data/users/types.js";
import type {
  InboundMessage,
  ChannelContext,
  OutboundEvent,
} from "../types/index.js";
import type { AgentRunDispatch } from "../agent/types.js";
import type { TokenUsageStore } from "../data/usage/store.js";
import type { TenantStore } from "../data/tenants/store.js";
import { checkTenantAccess } from "../data/tenants/access.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import type {
  CronJob,
  CronPayload,
  PayloadAgentTurn,
} from "./types.js";
import type { UserActivityService } from "../runtime/userActivityService.js";
import { buildMemoryPollPrompt, MEMORY_POLL_DEFAULTS } from "./memoryPoll.js";
import { tryAcquireMemoryMaintenance, releaseMemoryMaintenance } from "../memory/maintenanceLock.js";

export interface UserStoreLike {
  reload?(): void;
  findById(id: string): {
    id: string;
    username: string;
    role: 'admin' | 'user';
    disabled?: boolean;
    tenantId?: string;
    preferences?: UserPreferences;
  } | undefined;
}

export interface ExecutorOptions {
  /** Agent 执行函数（由组装层注入） */
  runAgent: AgentRunDispatch;
  /** Agent 工作目录 */
  agentCwd: string;
  /** 共享资源目录 */
  sharedDir: string;
  /** 默认模型 */
  defaultModel?: string;
  /** 默认最大轮次 */
  defaultMaxTurns?: number;
  /** 默认超时（秒） */
  defaultTimeoutSeconds?: number;
  /** 用户时区 */
  timezone?: string;
  /** 模型引用解析器：将 "groupId/modelId" 解析为 OpenAI Agents model + connection */
  resolveModel?: (ref: string, tenantId?: string) => ResolvedModel | null;
  /** 默认模型解析器：按 owner 所在组织解析“使用默认模型”。 */
  resolveDefaultModel?: (tenantId?: string) => (ResolvedModel & { ref: string }) | null;
  /** 用户存储（用于解析 owner 的 cwd） */
  userStore?: UserStoreLike;
  /** 组织存储（用于阻止 disabled tenant 的后台任务继续执行） */
  tenantStore?: TenantStore;
  /** session 创建时立即回调（不等执行完成），用于 pTimeout 场景保留 sessionId */
  onSessionId?: (sessionId: string, transcriptPath?: string) => void;
  /** Token 用量统计 store（可选） */
  tokenUsageStore?: TokenUsageStore;
  /** Skill 配置 store（用于 cron owner workspace 同步用户/组织 skill） */
  skillConfigStore?: SkillConfigStore;
  /** cron dispatch 前保证 owner workspace 的技能与脚本已完成异步物化。 */
  skillMaterialization?: Pick<SkillMaterializationCoordinator, "ensureReady">;
  /** 线上上传的组织自有 skill 持久化根目录 */
  tenantSkillsRootDir?: string;
  /** 用户活动聚合服务（memory_poll 系统任务的「无活动跳过」预检；未配置时预检跳过任务） */
  userActivityService?: UserActivityService;
  /** memory_poll 系统任务的执行参数（config.memory.polling） */
  memoryPoll?: {
    enabled?: boolean;
    lookbackHours?: number;
    maxTurns?: number;
    timeoutSeconds?: number;
    model?: string;
    /** 真正启动 Agent 前从持久化配置复核平台/组织/用户三层开关。 */
    isExecutionEnabled?: (tenantId: string, userId: string) => boolean | Promise<boolean>;
  };
  /**
   * L2 记忆整合桥（2026-07-29 职责剥离批次）：memory_poll 据此收敛职责——
   * 租户开 L2 → prompt 走 v3 收敛分支；写入期持统一 PG commit lock（与
   * L1/L2 共用，蓝绿跨进程正确性）；注入 tombstone 主题清单防复活。
   */
  memoryConsolidationBridge?: {
    isTenantConsolidationEnabled(tenantId: string | undefined): boolean;
    acquireCommitLock(tenantId: string, userId: string, timeoutMs?: number): Promise<{ release(): Promise<void> } | null>;
    listForgottenSubjects(tenantId: string, userId: string): Promise<string[]>;
  };
}

export interface ExecuteResult {
  status: "ok" | "error" | "skipped";
  error?: string;
  output?: string;
  /** 身份撤销或开关关闭等 fail-closed 结果不得继续触发外部通知。 */
  suppressNotification?: boolean;
  sessionId?: string;
  transcriptPath?: string;
  /** 本次实际使用的模型引用（group/model），用于 run log 展示与会话恢复。 */
  modelRef?: string;
}

export async function executeJob(
  job: CronJob,
  opts: ExecutorOptions
): Promise<ExecuteResult> {
  if (job.owner) {
    opts.userStore?.reload?.();
    const owner = opts.userStore?.findById(job.owner);
    if (!owner || owner.disabled) {
      return {
        status: "error",
        output: owner?.disabled ? "Job owner is disabled" : "Job owner does not exist",
        suppressNotification: true,
      };
    }
    opts.tenantStore?.reload?.();
    const tenantAccess = checkTenantAccess(opts.tenantStore, owner.tenantId);
    if (!tenantAccess.ok) {
      return { status: "error", output: tenantAccess.message, suppressNotification: true };
    }
  }

  if (job.systemKind === "memory_poll") {
    return await executeMemoryPollJob(job, opts);
  }
  const payload = job.payload as CronPayload;

  switch (payload.kind) {
    case "agentTurn":
      return await executeAgentTurn(job, payload, opts);

    case "systemEvent": {
      return { status: "ok", output: payload.text };
    }
  }
}

/**
 * memory_poll 系统任务（2026-07-14 批次）：
 *   - 忽略 payload.message，加载服务端版本化提示语（改提示语不用批量改 job）
 *   - 起 run 前先查最近 lookbackHours 有无用户主动消息，没有直接 skipped
 *     （多租户下大量不活跃用户每天空跑一次 LLM 是纯烧钱）
 *   - 套 memory_poll 受限工具白名单 + autoApprove（可写范围已被路径 guard 收窄）
 *   - 强制 server-remote：白名单含 Shell（prompt v2 起用 rg 扫 assets），guard
 *     不是硬边界，必须在隔离的 ACS 沙箱执行（2026-07-29 修正注释漂移，与
 *     toolProfiles.ts 安全模型及实际 executionTarget 一致）
 */
async function executeMemoryPollJob(
  job: CronJob,
  opts: ExecutorOptions
): Promise<ExecuteResult> {
  if (!job.owner || !opts.userStore) {
    return { status: "error", error: "memory_poll job 缺少 owner 或 userStore" };
  }
  opts.userStore.reload?.();
  const owner = opts.userStore.findById(job.owner);
  if (!owner || owner.disabled) {
    return { status: "skipped", output: "memory_poll owner 不存在或已禁用" };
  }
  if (opts.memoryPoll?.enabled !== true) {
    return { status: "skipped", output: "memory_poll 平台开关已关闭", suppressNotification: true };
  }
  if (!owner.tenantId || !opts.tenantStore) {
    return {
      status: "skipped",
      output: "memory_poll 缺少组织配置，按关闭处理",
      suppressNotification: true,
    };
  }
  try {
    opts.tenantStore.reload();
    if (opts.tenantStore.getSettings(owner.tenantId)?.features?.memoryPollingEnabled !== true) {
      return { status: "skipped", output: "memory_poll 组织开关已关闭", suppressNotification: true };
    }
  } catch {
    return {
      status: "skipped",
      output: "memory_poll 组织配置读取失败，按关闭处理",
      suppressNotification: true,
    };
  }

  const lookbackHours = opts.memoryPoll?.lookbackHours ?? MEMORY_POLL_DEFAULTS.lookbackHours;

  // 预检：无活动跳过（fail-closed——数据源不可用时不空跑模型）
  if (!opts.userActivityService?.available) {
    return { status: "skipped", output: "memory_poll 预检不可用（缺少 PG runtime event store），跳过本次轮询" };
  }
  const sinceIso = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const hasActivity = await opts.userActivityService.hasActivity({
    tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
    userId: owner.id,
    sinceIso,
  });
  if (hasActivity !== true) {
    return {
      status: "skipped",
      output: `最近 ${lookbackHours} 小时无用户主动消息，跳过本次记忆轮询`,
    };
  }

  // L2 整合桥（2026-07-29 职责剥离批次）：租户开 L2 → prompt 收敛为 v3 分支；
  // tombstone 主题清单（用户显式忘记）注入 prompt 防复活——store 可用即查，
  // 不依赖 L2 开关（tombstone 一旦存在就必须被 L3 尊重）。
  const bridge = opts.memoryConsolidationBridge;
  const consolidationActive = bridge?.isTenantConsolidationEnabled(owner.tenantId) === true;
  let forgottenSubjects: string[] = [];
  if (bridge) {
    forgottenSubjects = await bridge
      .listForgottenSubjects(owner.tenantId ?? DEFAULT_TENANT_ID, owner.id)
      .catch(() => []);
  }

  const basePayload = job.payload.kind === "agentTurn" ? job.payload : undefined;
  const effectivePayload: PayloadAgentTurn = {
    kind: "agentTurn",
    message: buildMemoryPollPrompt({ lookbackHours, consolidationActive, forgottenSubjects }),
    maxTurns: basePayload?.maxTurns ?? opts.memoryPoll?.maxTurns ?? MEMORY_POLL_DEFAULTS.maxTurns,
    timeoutSeconds: basePayload?.timeoutSeconds ?? opts.memoryPoll?.timeoutSeconds ?? MEMORY_POLL_DEFAULTS.timeoutSeconds,
    ...(basePayload?.model ?? opts.memoryPoll?.model
      ? { model: basePayload?.model ?? opts.memoryPoll?.model }
      : {}),
    // 记忆维护任务不带 persona 情境；MEMORY.md 让 agent 自己精读原文而不是吃注入摘要
    context: { persona: false, memory: false },
  };

  // 用户级维护互斥：与会后记忆维护（memoryHook）共用锁，拿不到就下一轮再来
  if (!tryAcquireMemoryMaintenance(owner.tenantId, owner.id)) {
    return { status: "skipped", output: "该用户已有记忆维护任务在进行，跳过本次轮询" };
  }
  // 统一 PG commit lock（2026-07-29 P2 修复）：L1/L2/L3 的记忆文件写入共用
  // 同一把跨进程锁。L3 run 用通用 Write/Edit 跨多轮写文件，无法只锁提交期，
  // 过渡期整个 run 持锁（GPT 复核报告认可的过渡语义）；拿不到 → skipped，
  // 由下一次调度重试，绝不无锁裸跑。进程内锁保持为 fast-path。
  let commitLock: { release(): Promise<void> } | null = null;
  if (bridge) {
    commitLock = await bridge
      .acquireCommitLock(owner.tenantId ?? DEFAULT_TENANT_ID, owner.id, 5_000)
      .catch(() => null);
    if (!commitLock) {
      releaseMemoryMaintenance(owner.tenantId, owner.id);
      return { status: "skipped", output: "记忆写入锁被其他记忆任务占用，跳过本次轮询" };
    }
  }
  try {
    return await executeAgentTurn(job, effectivePayload, opts, {
      toolProfile: "memory_poll",
      approvalPolicy: { autoApproveTools: true },
      executionTarget: "server-remote",
    });
  } finally {
    if (commitLock) await commitLock.release().catch(() => undefined);
    releaseMemoryMaintenance(owner.tenantId, owner.id);
  }
}

/** 系统任务（memory_poll）注入的 per-run 执行覆盖；普通 agentTurn 不传。 */
interface AgentTurnRunOverrides {
  toolProfile?: "memory_poll";
  approvalPolicy?: { autoApproveTools: boolean };
  executionTarget?: "server-remote";
}

async function executeAgentTurn(
  job: CronJob,
  payload: PayloadAgentTurn,
  opts: ExecutorOptions,
  overrides?: AgentTurnRunOverrides
): Promise<ExecuteResult> {
  const maxTurns = payload.maxTurns ?? opts.defaultMaxTurns ?? 10;
  const timeoutSecondsRaw = payload.timeoutSeconds ?? opts.defaultTimeoutSeconds ?? 120;
  const timeoutSeconds = Math.max(0, Math.floor(timeoutSecondsRaw));
  const timeoutMs = timeoutSeconds * 1000;

  // 超时机制：用 Promise.race 实现真正的异步超时，不依赖事件轮询。
  // 当 SDK 阻塞在长时间工具调用时，iterator.next() 会挂起，
  // 但 timeoutPromise 仍可在到期时 resolve，竞争中胜出触发中断。
  let didTimeoutAbort = false;
  let timeoutResolve: (() => void) | null = null;
  const timeoutPromise = timeoutSeconds > 0
    ? new Promise<void>((resolve) => { timeoutResolve = resolve; })
    : null;
  const timeout = timeoutSeconds > 0
    ? setTimeout(() => {
        didTimeoutAbort = true;
        timeoutResolve?.();
      }, timeoutMs)
    : null;

  // 根据 job owner 解析 per-user cwd + 身份信息。多进程部署下先刷新共享
  // 用户/组织文件，避免后台任务使用另一个 Web 进程更新前的旧权限状态。
  let effectiveAgentCwd = opts.agentCwd;
  opts.userStore?.reload?.();
  opts.tenantStore?.reload?.();
  const owner = (job.owner && opts.userStore) ? opts.userStore.findById(job.owner) : undefined;
  if (job.owner && !owner) {
    if (timeout) clearTimeout(timeout);
    return { status: 'error', output: 'Job owner does not exist' };
  }
  if (owner?.disabled) {
    if (timeout) clearTimeout(timeout);
    return { status: 'error', output: 'Job owner is disabled' };
  }
  if (owner) {
    const tenantAccess = checkTenantAccess(opts.tenantStore, owner.tenantId);
    if (!tenantAccess.ok) {
      if (timeout) clearTimeout(timeout);
      return { status: 'error', output: tenantAccess.message };
    }
  }
  if (owner) {
    // PR 6 P1-5：cron 路径透传 owner.tenantId，否则 wain 组织的 cron 任务会
    // 错路径到 kaiyan/<owner.username>/
    const workspaceUser = { id: owner.id, username: owner.username, role: owner.role, tenantId: owner.tenantId };
    effectiveAgentCwd = resolveUserCwd(opts.agentCwd, workspaceUser);
    await ensureUserWorkspace(
      effectiveAgentCwd,
      opts.agentCwd,
      opts.sharedDir,
      workspaceUser,
      undefined,
      opts.skillConfigStore,
      opts.tenantSkillsRootDir,
    );
    await opts.skillMaterialization?.ensureReady(owner.username, [], "cron");
  }

  let output = "";
  let sessionId: string | undefined;
  let transcriptPath: string | undefined;
  let modelRef: string | undefined;

  const deriveTranscriptPath = async () => {
    if (!sessionId || transcriptPath) return;

    // Best-effort derivation: Agent SaaS legacy transcript path.
    const candidate = getTranscriptPath(
      effectiveAgentCwd,
      sessionId,
      owner ? { tenantId: owner.tenantId, userId: owner.id } : undefined,
    );
    try {
      await fs.access(candidate);
      transcriptPath = candidate;
    } catch {
      // ignore: details endpoint will attempt a broader lookup by sessionId
    }
  };

  try {
    let model: string | undefined;
    let modelConnection: { apiKey?: string; baseUrl?: string } | undefined;
    let modelProviderOptions: ResolvedModel['providerOptions'] | undefined;

    const explicitModelRef = payload.model;
    if (explicitModelRef) {
      modelRef = explicitModelRef;
      if (explicitModelRef.includes('/') && opts.resolveModel) {
        const resolved = opts.resolveModel(explicitModelRef, owner?.tenantId);
        if (!resolved) throw new Error(`定时任务模型不可用: ${explicitModelRef}`);
        model = resolved.model;
        modelConnection = resolved.connection;
        modelProviderOptions = resolved.providerOptions;
      } else {
        model = explicitModelRef;
      }
    } else {
      const resolvedDefault = opts.resolveDefaultModel?.(owner?.tenantId);
      if (resolvedDefault) {
        modelRef = resolvedDefault.ref;
        model = resolvedDefault.model;
        modelConnection = resolvedDefault.connection;
        modelProviderOptions = resolvedDefault.providerOptions;
      } else if (opts.defaultModel) {
        modelRef = opts.defaultModel;
        if (opts.defaultModel.includes('/') && opts.resolveModel) {
          const resolved = opts.resolveModel(opts.defaultModel, owner?.tenantId);
          if (!resolved) throw new Error(`默认模型不可用: ${opts.defaultModel}`);
          model = resolved.model;
          modelConnection = resolved.connection;
          modelProviderOptions = resolved.providerOptions;
        } else {
          model = opts.defaultModel;
        }
      }
    }

    const prompt = payload.message;

    let resultText: string | undefined;
    let runError: string | undefined;

    const inbound: InboundMessage = {
      channel: "cron",
      chatId: job.id,
      content: prompt,
    };
    const context: ChannelContext = {
      channel: "cron",
      timezone: opts.timezone,
      // PR 10 修复：cron 路径的 ChannelContext.user 必须带 tenantId，否则下游
      // rawAgentLoop emit tool_audit 时拿不到 tenantId，会一律兜底平台根组织，
      // 跨组织 cron job 的 audit 会全部错归默认组织、破坏组织隔离。
      ...(owner ? { user: { id: owner.id, username: owner.username, role: owner.role, tenantId: owner.tenantId } } : {}),
    };
    const approvalPolicy = overrides?.approvalPolicy
      ?? (owner?.preferences?.authorizationModeEnabled === true
        ? { autoApproveTools: true }
        : undefined);

    // 不将 abortController 传入 SDK：SDK 内部 handleControlRequest 的
    // 双重 transport.write 在 abort 后会抛出未捕获的 AbortError，
    // 导致进程崩溃。改为手动迭代 + Promise.race 实现真正的异步超时。
    // 从 payload.context 映射上下文注入开关
    const ctx = payload.context;
    const skipFlags = ctx ? {
      ...(ctx.systemPrompt === false ? { skipSystemPrompt: true } : {}),
      ...(ctx.persona === false ? { skipPersona: true } : {}),
      ...(ctx.memory === false ? { skipMemory: true } : {}),
    } : {};

    if (job.owner) {
      opts.userStore?.reload?.();
      opts.tenantStore?.reload?.();
      const currentOwner = opts.userStore?.findById(job.owner);
      const currentTenantAccess = checkTenantAccess(opts.tenantStore, currentOwner?.tenantId);
      if (
        !currentOwner
        || currentOwner.disabled
        || currentOwner.tenantId !== owner?.tenantId
        || !currentTenantAccess.ok
      ) {
        return {
          status: 'error',
          output: currentTenantAccess.ok ? 'Job owner is unavailable' : currentTenantAccess.message,
          suppressNotification: true,
        };
      }
    }

    if (job.systemKind === 'memory_poll') {
      let stillEnabled = false;
      try {
        stillEnabled = !!owner?.tenantId
          && !!opts.memoryPoll?.isExecutionEnabled
          && await opts.memoryPoll.isExecutionEnabled(owner.tenantId, owner.id);
      } catch {
        stillEnabled = false;
      }
      if (!stillEnabled) {
        return {
          status: 'skipped',
          output: 'memory_poll 开关已关闭，取消本次执行',
          suppressNotification: true,
        };
      }
    }

    const events = opts.runAgent(
      inbound,
      context,
      {
        cwd: effectiveAgentCwd,
        maxTurns,
        ...(model !== undefined ? { model } : {}),
        ...(modelRef ? { modelRef } : {}),
        ...(modelConnection ? { modelConnection } : {}),
        ...(modelProviderOptions ? { modelProviderOptions } : {}),
        persistSession: true,
        includePartialMessages: true,
        ...skipFlags,
        ...(overrides?.toolProfile ? { toolProfile: overrides.toolProfile } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(overrides?.executionTarget ? { executionTarget: overrides.executionTarget } : {}),
      },
      {
        onSessionStart: (startedSessionId, startedTranscriptPath) => {
          sessionId = startedSessionId;
          transcriptPath = startedTranscriptPath ?? transcriptPath;

          // 立即上报 sessionId，确保即使 pTimeout 打断也能归组
          opts.onSessionId?.(startedSessionId, transcriptPath);

          // raw dispatch 已经写入完整 session meta。这里只 merge cron 展示字段，
          // 禁止用不完整对象覆盖 cwd/model/execution/workspace/Profile 版本绑定。
          if (owner && startedSessionId) {
            const tp = startedTranscriptPath ?? getTranscriptPath(effectiveAgentCwd, startedSessionId, { tenantId: owner.tenantId, userId: owner.id });
            updateSessionMeta(tp, {
              cronJobName: job.name,
              ...(job.systemKind ? { cronSystemKind: job.systemKind } : {}),
            }).catch((err) => {
              console.warn(`[cron/meta] Failed to update session meta: sessionId=${startedSessionId} error=${err}`);
            });
          }
        },
        onResult: (meta) => {
          resultText = meta.resultText ?? resultText;
          // 写入 token_usage_daily（按 cron job owner 归属，按模型拆行）
          if (opts.tokenUsageStore && owner && meta.modelUsage && Object.keys(meta.modelUsage).length > 0) {
            try {
              opts.tokenUsageStore.recordResult({
                username: owner.username,
                // owner.tenantId 类型为 string（UserRecord 必填）；闭包内 TS narrow 保守，加 non-null。
                tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
                channel: 'cron',
                modelUsage: meta.modelUsage,
                occurredAtMs: Date.now(),
              });
            } catch (err) {
              console.warn(`[token-usage] cron record failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        },
      },
    );

    try {
      let completed = false;
      // 手动迭代 async generator：每次 next() 与超时 Promise 竞争，
      // 即使 SDK 阻塞在工具调用中不产出事件，超时仍能触发。
      const TIMEOUT_SENTINEL = Symbol("timeout");
      while (true) {
        const nextValue = timeoutPromise
          ? await Promise.race([
              events.next(),
              timeoutPromise.then((): { done: true; value: typeof TIMEOUT_SENTINEL } =>
                ({ done: true, value: TIMEOUT_SENTINEL })),
            ])
          : await events.next();

        if (nextValue.value === TIMEOUT_SENTINEL) {
          didTimeoutAbort = true;
          break;
        }
        if (nextValue.done) break;

        const event = nextValue.value as OutboundEvent;
        if (event.type === "session_init" && event.sessionId) {
          sessionId = event.sessionId;
        } else if (event.type === "text_delta" && typeof event.content === "string") {
          output += event.content;
        } else if (event.type === "error") {
          runError = event.error || "Unknown error";
        } else if (event.type === "done") {
          // done 表示 runner 最终成功完成；之前的 error event 是中间态（如重试前的连接异常），已恢复
          completed = true;
          runError = undefined;
        }
      }

      if (!completed && !didTimeoutAbort && !runError) {
        runError = "Agent run ended without a successful terminal event (可能正在等待审批或用户输入)";
      }
    } finally {
      // 确保 generator 清理：break 后级联关闭 SDK 子进程
      await events.return(undefined as any);
    }

    if (didTimeoutAbort) {
      throw new Error(`Execution timeout after ${timeoutSeconds}s`);
    }

    if (runError) {
      throw new Error(runError);
    }

    if (typeof resultText === "string" && resultText.trim()) {
      output = resultText;
    }

    await deriveTranscriptPath();
    return { status: "ok", output, sessionId, transcriptPath, modelRef };
  } catch (err) {
    let error = String(err);
    if (didTimeoutAbort) {
      error = `Execution timeout after ${timeoutSeconds}s`;
    }
    await deriveTranscriptPath();
    return { status: "error", error, output, sessionId, transcriptPath, modelRef };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

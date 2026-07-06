/**
 * Cron 任务执行器
 */
import * as fs from "node:fs/promises";
import { getTranscriptPath } from "../data/transcripts/store.js";
import { writeSessionMeta } from "../data/transcripts/meta.js";
import { resolveUserCwd, ensureUserWorkspace } from "../workspace/resolver.js";
import type { ResolvedModel } from "../app/models.js";
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

export interface UserStoreLike {
  findById(id: string): { id: string; username: string; role: 'admin' | 'user'; disabled?: boolean; tenantId?: string } | undefined;
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
}

export interface ExecuteResult {
  status: "ok" | "error" | "skipped";
  error?: string;
  output?: string;
  sessionId?: string;
  transcriptPath?: string;
  /** 本次实际使用的模型引用（group/model），用于 run log 展示与会话恢复。 */
  modelRef?: string;
}

export async function executeJob(
  job: CronJob,
  opts: ExecutorOptions
): Promise<ExecuteResult> {
  const payload = job.payload as CronPayload;

  switch (payload.kind) {
    case "agentTurn":
      return await executeAgentTurn(job, payload, opts);

    case "systemEvent": {
      return { status: "ok", output: payload.text };
    }
  }
}

async function executeAgentTurn(
  job: CronJob,
  payload: PayloadAgentTurn,
  opts: ExecutorOptions
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

  // 根据 job owner 解析 per-user cwd + 身份信息
  let effectiveAgentCwd = opts.agentCwd;
  const owner = (job.owner && opts.userStore) ? opts.userStore.findById(job.owner) : undefined;
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
    await ensureUserWorkspace(effectiveAgentCwd, opts.agentCwd, opts.sharedDir, workspaceUser);
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
      },
      {
        onSessionStart: (startedSessionId, startedTranscriptPath) => {
          sessionId = startedSessionId;
          transcriptPath = startedTranscriptPath ?? transcriptPath;

          // 立即上报 sessionId，确保即使 pTimeout 打断也能归组
          opts.onSessionId?.(startedSessionId, transcriptPath);

          // 写入 session meta，使 cron 会话能出现在用户的会话列表中
          if (owner && startedSessionId) {
            const tp = startedTranscriptPath ?? getTranscriptPath(effectiveAgentCwd, startedSessionId, { tenantId: owner.tenantId, userId: owner.id });
            writeSessionMeta(tp, {
              userId: owner.id,
              username: owner.username,
              tenantId: owner.tenantId,
              channel: 'cron',
              createdAt: new Date().toISOString(),
              cronJobName: job.name,
            }).catch((err) => {
              console.warn(`[cron/meta] Failed to write session meta: sessionId=${startedSessionId} error=${err}`);
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
          runError = undefined;
        }
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

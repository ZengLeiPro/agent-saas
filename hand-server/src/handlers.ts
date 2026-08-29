import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ContainerExecutionProvider,
  ServerLocalExecutionProvider,
  type ExecutionProvider,
  type ExecutionTargetKind,
  type WorkspaceRef,
} from 'server/agent/toolRuntime.js';
import { unknownNetworkPolicyStatus } from 'server/runtime/networkPolicy.js';
import { pickHandEnv } from 'server/runtime/handEnvAllowlist.js';
import type { ToolInvocationRequest, ToolInvocationResponse } from 'server/runtime/handProtocol.js';

import type { HandServerConfig } from './config.js';
import type { HandInvocationStore, RegisterRunningOutcome } from './invocationStore.js';
import { MAX_BODY_BYTES, readBody, sendJson } from './httpSupport.js';
import type { WorkspaceResolver } from './workspaceResolver.js';

/**
 * POST /provision 已拆到 provision.ts（TASK-316 为 handlers.ts 减行）；
 * 这里 re-export 保持 `./handlers.js` 既有 import 兼容。
 */
export { handleProvision, parseProvisionRecipe } from './provision.js';
export type { ProvisioningLogEntry, ParsedRecipe } from './provision.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface InvocationResultRecord {
  response: ToolInvocationResponse;
  createdAt: number;
}

export interface HandlerDeps {
  config: HandServerConfig;
  invocations?: Map<string, AbortController>;
  invocationResults?: Map<string, InvocationResultRecord>;
  /**
   * Durable Tool Invocation journal（TASK-316）：invocation 状态/结果/cancel tombstone
   * 落盘，Hand 重启后仍可查询与对账。缺省 = 纯内存旧行为（测试/显式 memory 模式）。
   */
  invocationStore?: HandInvocationStore;
  /**
   * SIGTERM drain 中：新 invocation 一律 503。Brain 侧 fetchWithConnectRetry 对
   * 裸 503（无 x-acs-error-code）有"请求未被执行"语义的安全退避重试，正好衔接。
   */
  draining?: boolean;
  /** 在途 invocation 跟踪（drain 等待收尾用）；key 唯一，含无 invocationId 的请求。 */
  activeInvocations?: Set<string>;
  workspaceResolver: WorkspaceResolver;
  provider: ExecutionProvider;
  /**
   * Hand 端内部 backend 名（写进 WorkspaceRef.executionTarget）。
   * 注意这跟 brain 侧调用时的 `executionTarget=server-remote` 是不同维度--
   * brain 视角描述 hand 部署位置，hand 内部视角描述实际跑的 backend，
   * audit 字段需要后者作为 provider 标识。
   */
  internalExecutionTarget: ExecutionTargetKind;
  logger: Logger;
}

export function buildHealthResponse(deps: HandlerDeps): Record<string, unknown> {
  const networkPolicy =
    deps.provider instanceof ContainerExecutionProvider
      ? deps.provider.networkPolicyStatus()
      : unknownNetworkPolicyStatus(
          deps.config.networkPolicy,
          'Local hand backend does not enforce coding-hand networkPolicy. Use container/ACS backends for isolation.',
        );
  return {
    status: 'ok',
    backend: deps.config.backend,
    internalExecutionTarget: deps.internalExecutionTarget,
    ...(deps.draining ? { draining: true } : {}),
    ...(deps.activeInvocations ? { activeInvocations: deps.activeInvocations.size } : {}),
    ...(deps.invocationStore ? { durableInvocations: true } : {}),
    networkPolicy,
    container:
      deps.config.backend === 'container'
        ? {
            image:
              deps.config.container.image ??
              process.env.KY_AGENT_CONTAINER_IMAGE ??
              'node:22-bookworm-slim',
            user: deps.config.container.user ?? 'process uid/gid',
            readOnly: deps.config.container.readOnly ?? true,
            network: 'none',
            networkPolicy,
            capDrop: deps.config.container.capDrop ?? ['ALL'],
            securityOpt: deps.config.container.securityOpt ?? ['no-new-privileges'],
            memory:
              deps.config.container.memory ?? process.env.KY_AGENT_CONTAINER_MEMORY ?? '1024m',
            cpus: deps.config.container.cpus ?? process.env.KY_AGENT_CONTAINER_CPUS ?? '1.0',
            pidsLimit:
              deps.config.container.pidsLimit ??
              Number.parseInt(process.env.KY_AGENT_CONTAINER_PIDS_LIMIT ?? '256', 10),
          }
        : undefined,
    tools: deps.provider.listInternalTools().map((tool) => tool.name),
  };
}

export function buildToolsResponse(deps: HandlerDeps): Record<string, unknown> {
  return {
    status: 'ok',
    backend: deps.config.backend,
    internalExecutionTarget: deps.internalExecutionTarget,
    tools: deps.provider.listInternalTools().map((tool) => ({
      id: tool.id,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      risk: tool.risk,
      approvalMode: tool.approvalMode,
      auditCategory: tool.auditCategory,
    })),
  };
}

export function createProvider(config: HandServerConfig): ExecutionProvider {
  const backend = config.backend;
  return backend === 'container'
    ? new ContainerExecutionProvider({
        image: config.container.image,
        dockerPath: config.container.dockerPath,
        user: config.container.user,
        memory: config.container.memory,
        cpus: config.container.cpus,
        pidsLimit: config.container.pidsLimit,
      })
    : new ServerLocalExecutionProvider();
}

export function backendToTarget(backend: 'local' | 'container'): ExecutionTargetKind {
  return backend === 'container' ? 'server-container' : 'server-local';
}

const INVOCATION_RESULT_TTL_MS = 10 * 60_000;
const INVOCATION_RESULT_MAX = 10_000;

function storeInvocationResult(
  deps: HandlerDeps,
  invocationId: string | undefined,
  response: ToolInvocationResponse,
): void {
  if (!invocationId || !deps.invocationResults) return;
  const results = deps.invocationResults;
  if (results.has(invocationId)) results.delete(invocationId);
  while (results.size >= INVOCATION_RESULT_MAX) {
    const oldestId = results.keys().next().value as string | undefined;
    if (!oldestId) break;
    results.delete(oldestId);
  }
  const record: InvocationResultRecord = { response, createdAt: Date.now() };
  results.set(invocationId, record);
  const timer = setTimeout(() => {
    if (results.get(invocationId) === record) results.delete(invocationId);
  }, INVOCATION_RESULT_TTL_MS);
  timer.unref?.();
}

/** Durable journal 落终态：失败只记日志，不吞掉已算出的结果（内存快路径仍可用）。 */
async function persistInvocationResult(
  deps: HandlerDeps,
  invocationId: string | undefined,
  response: ToolInvocationResponse,
): Promise<void> {
  if (!invocationId || !deps.invocationStore) return;
  try {
    await deps.invocationStore.complete(invocationId, response);
  } catch (err) {
    deps.logger.error(
      `invocation store complete failed invocation=${invocationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function storeAndPersistInvocationResult(
  deps: HandlerDeps,
  invocationId: string | undefined,
  response: ToolInvocationResponse,
): Promise<void> {
  storeInvocationResult(deps, invocationId, response);
  await persistInvocationResult(deps, invocationId, response);
}

function markDurableReplay(response: ToolInvocationResponse): ToolInvocationResponse {
  return {
    ...response,
    metadata: { ...(response.metadata ?? {}), durableReplay: true },
  };
}

interface PreparedToolInvocation {
  ok: true;
  toolRequest: ToolInvocationRequest;
  invocationId?: string;
  abort: () => void;
  cleanup: () => void;
}

interface ReplayedToolInvocation {
  ok: true;
  replay: ToolInvocationResponse;
}

let anonymousInvocationSeq = 0;

/** Shared parser/executor for /execute and /execute-stream. */
async function prepareToolInvocation(
  req: IncomingMessage,
  deps: HandlerDeps,
): Promise<
  | PreparedToolInvocation
  | ReplayedToolInvocation
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  if (req.method !== 'POST') {
    return {
      ok: false,
      status: 405,
      body: { status: 'error', error: 'method not allowed; use POST' },
    };
  }

  // drain 中拒绝新 invocation：请求尚未执行任何副作用，brain 侧按 503 安全重试。
  if (deps.draining) {
    return {
      ok: false,
      status: 503,
      body: { status: 'error', error: 'hand-server draining; retry after restart' },
    };
  }

  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken) {
    deps.logger.warn(`auth 失败 from=${req.socket.remoteAddress ?? '-'}`);
    return { ok: false, status: 401, body: { status: 'error', error: 'unauthorized' } };
  }

  let bodyRaw: string;
  try {
    bodyRaw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return {
      ok: false,
      status: 413,
      body: {
        status: 'error',
        error: `body 读取失败: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyRaw);
  } catch {
    return { ok: false, status: 400, body: { status: 'error', error: 'body 不是合法 JSON' } };
  }

  const parsed = parseWireRequest(body);
  if (!parsed.ok) return { ok: false, status: 400, body: { status: 'error', error: parsed.error } };
  const wire = parsed.value;

  let workspaceRoot: string;
  try {
    workspaceRoot = await deps.workspaceResolver.resolveAndEnsure(wire.context.workspace.id);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: { status: 'error', error: err instanceof Error ? err.message : String(err) },
    };
  }

  const invocationId = wire.context.invocationId;
  const existingInvocation = invocationId ? deps.invocations?.get(invocationId) : undefined;
  if (invocationId && existingInvocation) {
    return {
      ok: false,
      status: 409,
      body: {
        status: 'error',
        error: existingInvocation.signal.aborted
          ? 'invocation cancelled before start'
          : 'invocation already running',
        invocationId,
      },
    };
  }
  // 先同步占位内存 registry（进程内 single-flight），journal 异步登记失败时回滚。
  const controller = invocationId ? registerInvocation(deps, invocationId) : undefined;

  // Durable journal（TASK-316）：在 provider 产生任何副作用之前完成
  // 重放/拒绝判定与 running 登记，保证"重启后重复派发不二次执行"。
  if (invocationId && deps.invocationStore) {
    let registered: RegisterRunningOutcome;
    try {
      registered = await deps.invocationStore.registerRunning(invocationId);
    } catch (err) {
      deps.invocations?.delete(invocationId);
      deps.logger.error(
        `invocation store registerRunning failed invocation=${invocationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        status: 503,
        body: {
          status: 'error',
          error: `hand invocation store unavailable: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    if (registered.outcome === 'replay') {
      deps.invocations?.delete(invocationId);
      deps.logger.info(`replaying durable invocation result invocation=${invocationId}`);
      return { ok: true, replay: markDurableReplay(registered.record.response!) };
    }
    if (registered.outcome === 'cancelled_tombstone') {
      deps.invocations?.delete(invocationId);
      return {
        ok: false,
        status: 409,
        body: { status: 'error', error: 'invocation cancelled before start', invocationId },
      };
    }
    if (registered.outcome === 'already_running') {
      deps.invocations?.delete(invocationId);
      return {
        ok: false,
        status: 409,
        body: { status: 'error', error: 'invocation already running', invocationId },
      };
    }
  }

  const trackingKey = invocationId ?? `anon-${(anonymousInvocationSeq += 1)}`;
  let completed = false;
  const abort = () => {
    if (completed || !controller) return;
    controller.abort();
    if (invocationId) retainCancelledInvocation(deps, invocationId, controller);
  };
  // IncomingMessage 的正常消费也可能触发 close；只有 aborted 才代表请求异常中断。
  req.on('aborted', abort);

  const workspace: WorkspaceRef = {
    id: wire.context.workspace.id,
    root: workspaceRoot,
    userId: wire.context.workspace.userId,
    username: wire.context.workspace.username,
    sessionId: wire.context.workspace.sessionId,
    executionTarget: deps.internalExecutionTarget,
  };

  const toolRequest: ToolInvocationRequest = {
    toolName: wire.toolName,
    input: wire.input,
    context: {
      ...(invocationId ? { invocationId } : {}),
      workspace,
      ...(wire.context.env ? { env: wire.context.env } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    },
  };
  deps.activeInvocations?.add(trackingKey);
  return {
    ok: true,
    toolRequest,
    ...(invocationId ? { invocationId } : {}),
    abort,
    cleanup: () => {
      completed = true;
      req.off('aborted', abort);
      deps.activeInvocations?.delete(trackingKey);
      if (invocationId && !controller?.signal.aborted) deps.invocations?.delete(invocationId);
    },
  };
}

async function executePreparedTool(
  prepared: PreparedToolInvocation,
  deps: HandlerDeps,
): Promise<ToolInvocationResponse> {
  let response: ToolInvocationResponse;
  try {
    response = await deps.provider.execute(prepared.toolRequest);
  } catch (err) {
    response = {
      status: 'error',
      error: `hand-server provider.execute throw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await storeAndPersistInvocationResult(deps, prepared.invocationId, response);
  prepared.cleanup();
  return response;
}

/**
 * POST /execute handler。
 */
export async function handleExecute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const prepared = await prepareToolInvocation(req, deps);
  if (!prepared.ok) return sendJson(res, prepared.status, prepared.body);
  if ('replay' in prepared) return sendJson(res, 200, prepared.replay);
  const abortOnResponseClose = () => {
    if (!res.writableEnded) prepared.abort();
  };
  res.on('close', abortOnResponseClose);
  try {
    const response = await executePreparedTool(prepared, deps);
    return sendJson(res, 200, response);
  } finally {
    res.off('close', abortOnResponseClose);
  }
}

export async function handleExecuteStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const prepared = await prepareToolInvocation(req, deps);
  if (!prepared.ok) return sendJson(res, prepared.status, prepared.body);
  if ('replay' in prepared) {
    // 重复派发：直接以 SSE 重放持久化终态，不触碰 provider。
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(
      `data: ${JSON.stringify({ type: 'progress', message: 'hand invocation result replayed from durable journal' })}\n\n`,
    );
    res.end(`data: ${JSON.stringify({ type: 'completed', response: prepared.replay })}\n\n`);
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  let sawCompleted = false;
  let closed = false;
  const markClosed = () => {
    closed = true;
    prepared.abort();
  };
  res.on('close', markClosed);
  const isClosed = () => closed || res.destroyed || res.writableEnded;
  let writeQueue: Promise<boolean> = Promise.resolve(true);
  const waitForDrain = () =>
    new Promise<void>((resolve) => {
      if (isClosed()) {
        resolve();
        return;
      }
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        res.off('error', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
      res.once('error', done);
    });
  const writeChunk = async (chunk: unknown) => {
    writeQueue = writeQueue.then(async () => {
      if (
        isClosed() ||
        (sawCompleted &&
          (!chunk ||
            typeof chunk !== 'object' ||
            (chunk as { type?: unknown }).type !== 'completed'))
      )
        return false;
      if (chunk && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'completed')
        sawCompleted = true;
      const ok = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (!ok) await waitForDrain();
      return !isClosed();
    });
    return await writeQueue;
  };
  await writeChunk({ type: 'progress', message: 'hand invocation accepted' });
  const heartbeat = setInterval(() => {
    void writeChunk({ type: 'progress', message: 'hand invocation running' }).catch((err) => {
      deps.logger.warn(
        `stream heartbeat failed invocation=${prepared.invocationId ?? '-'}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, 10_000);
  heartbeat.unref?.();
  try {
    if (deps.provider.executeStream) {
      for await (const chunk of deps.provider.executeStream(prepared.toolRequest)) {
        if (chunk.type === 'completed') {
          sawCompleted = true;
          await storeAndPersistInvocationResult(deps, prepared.invocationId, chunk.response);
        }
        const written = await writeChunk(chunk);
        if (!written) break;
      }
    } else {
      const response = await executePreparedTool(prepared, deps);
      sawCompleted = true;
      await writeChunk({ type: 'completed', response });
    }
  } catch (err) {
    const response: ToolInvocationResponse = {
      status: 'error',
      error: `hand-server provider.executeStream throw: ${err instanceof Error ? err.message : String(err)}`,
    };
    await storeAndPersistInvocationResult(deps, prepared.invocationId, response);
    sawCompleted = true;
    await writeChunk({ type: 'completed', response });
  } finally {
    clearInterval(heartbeat);
    if (!sawCompleted) {
      const response: ToolInvocationResponse = {
        status: 'error',
        error: 'provider stream ended without completed chunk',
      };
      await storeAndPersistInvocationResult(deps, prepared.invocationId, response);
      await writeChunk({ type: 'completed', response });
    }
    res.off('close', markClosed);
    prepared.cleanup();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

export async function handleCancelInvocation(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  invocationId: string,
): Promise<void> {
  if (req.method !== 'DELETE')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use DELETE' });
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken)
    return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const controller = deps.invocations?.get(invocationId) ?? new AbortController();
  controller.abort();
  retainCancelledInvocation(deps, invocationId, controller);
  // Durable cancel tombstone（TASK-316）：cancel 意图落盘，Hand 重启后
  // 重复派发同一 invocationId 仍会被拒绝，cancel-before-start 语义不丢。
  if (deps.invocationStore) {
    try {
      await deps.invocationStore.markCancelled(invocationId);
    } catch (err) {
      deps.logger.error(
        `invocation store markCancelled failed invocation=${invocationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return sendJson(res, 200, { status: 'ok', invocationId, cancelled: true });
}

export async function handleGetInvocationResult(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  invocationId: string,
): Promise<void> {
  if (req.method !== 'GET')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use GET' });
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken)
    return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const record = deps.invocationResults?.get(invocationId);
  if (record) {
    return sendJson(res, 200, {
      status: 'ok',
      invocationId,
      completed: true,
      response: record.response,
      createdAt: record.createdAt,
    });
  }
  const invocation = deps.invocations?.get(invocationId);
  if (invocation) {
    return sendJson(res, 200, {
      status: 'ok',
      invocationId,
      completed: false,
      cancelled: invocation.signal.aborted,
    });
  }
  // Durable journal（TASK-316）：内存未命中（含刚重启）时查磁盘，
  // 让 Brain 在 Hand 重启后仍能对账结果/cancel/interrupted 状态。
  if (deps.invocationStore) {
    const stored = await deps.invocationStore.get(invocationId).catch((err) => {
      deps.logger.error(
        `invocation store get failed invocation=${invocationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    });
    if (stored) {
      if (stored.response) {
        const completedAtMs = new Date(stored.updatedAt).getTime();
        return sendJson(res, 200, {
          status: 'ok',
          invocationId,
          completed: true,
          response: stored.response,
          ...(Number.isFinite(completedAtMs) ? { createdAt: completedAtMs } : {}),
          ...(stored.cancelledAt ? { cancelled: true } : {}),
          ...(stored.interruptedAt ? { interrupted: true } : {}),
        });
      }
      return sendJson(res, 200, {
        status: 'ok',
        invocationId,
        completed: false,
        cancelled: stored.state === 'cancelled',
      });
    }
  }
  return sendJson(res, 404, {
    status: 'error',
    error: 'invocation result not found',
    invocationId,
  });
}

export async function handleWorkspaceLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  workspaceId: string,
  action: 'archive' | 'reset',
): Promise<void> {
  if (req.method !== 'POST')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken) {
    deps.logger.warn(`workspace ${action} auth 失败 from=${req.socket.remoteAddress ?? '-'}`);
    return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  }

  let reason: string = action;
  try {
    const bodyRaw = await readBody(req, MAX_BODY_BYTES);
    if (bodyRaw.trim()) {
      const body = JSON.parse(bodyRaw) as { reason?: unknown };
      if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim();
    }
  } catch (err) {
    return sendJson(res, 400, {
      status: 'error',
      error: `body 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    const result = await deps.workspaceResolver.archive(workspaceId, `${action}-${reason}`);
    deps.logger.info(
      `workspace_${action} workspaceId=${result.workspaceId} archived=${result.archived} archiveId=${result.archiveId ?? '-'} missing=${result.missing === true}`,
    );
    return sendJson(res, 200, {
      status: 'ok',
      action,
      workspaceId: result.workspaceId,
      archived: result.archived,
      missing: result.missing === true,
      ...(result.archiveId ? { archiveId: result.archiveId } : {}),
      note:
        action === 'reset'
          ? 'workspace archived; next provision will create a fresh workspace directory'
          : 'workspace archived; no files were deleted',
    });
  } catch (err) {
    return sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const CANCELLED_INVOCATION_TOMBSTONE_TTL_MS = 10 * 60_000;
const CANCELLED_INVOCATION_TOMBSTONE_MAX = 10_000;
const cancelledInvocationTimers = new WeakMap<AbortController, ReturnType<typeof setTimeout>>();

function retainCancelledInvocation(
  deps: HandlerDeps,
  invocationId: string,
  controller: AbortController,
): void {
  const invocations = deps.invocations;
  if (!invocations) return;
  let abortedEntries = 0;
  let oldestAbortedId: string | undefined;
  for (const [id, entry] of invocations) {
    if (id === invocationId || !entry.signal.aborted) continue;
    abortedEntries += 1;
    oldestAbortedId ??= id;
  }
  if (abortedEntries >= CANCELLED_INVOCATION_TOMBSTONE_MAX && oldestAbortedId) {
    const evicted = invocations.get(oldestAbortedId);
    if (evicted) {
      const timer = cancelledInvocationTimers.get(evicted);
      if (timer) clearTimeout(timer);
      cancelledInvocationTimers.delete(evicted);
    }
    invocations.delete(oldestAbortedId);
  }
  // Map.set 不会刷新既有 key 的插入顺序；先删后加，使容量淘汰与 TTL 刷新一致。
  if (invocations.get(invocationId) === controller) invocations.delete(invocationId);
  invocations.set(invocationId, controller);
  const priorTimer = cancelledInvocationTimers.get(controller);
  if (priorTimer) clearTimeout(priorTimer);
  const timer = setTimeout(() => {
    if (invocations.get(invocationId) === controller) invocations.delete(invocationId);
    cancelledInvocationTimers.delete(controller);
  }, CANCELLED_INVOCATION_TOMBSTONE_TTL_MS);
  cancelledInvocationTimers.set(controller, timer);
  timer.unref?.();
}

function registerInvocation(deps: HandlerDeps, invocationId: string): AbortController {
  const controller = new AbortController();
  deps.invocations?.set(invocationId, controller);
  return controller;
}

interface WireRequest {
  toolName: string;
  input: unknown;
  context: {
    invocationId?: string;
    workspace: {
      id?: string;
      userId?: string;
      username?: string;
      sessionId?: string;
      executionTarget?: string;
    };
    /**
     * 07-05：wire.context.env 透传给下游 provider（例如 acs-orchestrator sandboxRunner）
     * 用于给 pod 内子进程 env 补 AZEROTH_TOKEN 等 allowlist 凭据。仅限
     * HAND_ENV_ALLOWLIST 内的 key，parseWireRequest 会 pickHandEnv 二次剥离。
     */
    env?: Record<string, string>;
  };
}

export function parseWireRequest(
  body: unknown,
): { ok: true; value: WireRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body 必须是 object' };
  const b = body as Record<string, unknown>;
  if (typeof b.toolName !== 'string' || !b.toolName) {
    return { ok: false, error: 'toolName 必须为非空字符串' };
  }
  const context = b.context as Record<string, unknown> | undefined;
  const workspace = context?.workspace as Record<string, unknown> | undefined;
  if (!workspace || typeof workspace !== 'object') {
    return { ok: false, error: 'context.workspace 必须是 object' };
  }
  const rawEnv = context?.env;
  const env =
    rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
      ? pickHandEnv(rawEnv as Record<string, string | undefined>)
      : {};
  const envKeys = Object.keys(env);

  return {
    ok: true,
    value: {
      toolName: b.toolName,
      input: b.input ?? {},
      context: {
        invocationId: typeof context?.invocationId === 'string' ? context.invocationId : undefined,
        workspace: {
          id: typeof workspace.id === 'string' ? workspace.id : undefined,
          userId: typeof workspace.userId === 'string' ? workspace.userId : undefined,
          username: typeof workspace.username === 'string' ? workspace.username : undefined,
          sessionId: typeof workspace.sessionId === 'string' ? workspace.sessionId : undefined,
          executionTarget:
            typeof workspace.executionTarget === 'string' ? workspace.executionTarget : undefined,
        },
        ...(envKeys.length > 0 ? { env } : {}),
      },
    },
  };
}

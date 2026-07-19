import type { ToolDescriptor, WorkspaceRef } from '../agent/toolRuntime.js';
import { WORKSPACE_HAND_TOOLS } from '../agent/toolRuntime.js';
import type { ExecutionTransport } from './executionTransport.js';
import type { WorkspaceRecipe } from './handStore.js';
import { pickHandEnv } from './handEnvAllowlist.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
  ToolInvocationStream,
  ToolInvocationStreamChunk,
} from './handProtocol.js';

const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
/**
 * 连接类瞬时失败重试退避（2026-07-15 零停机部署批次）。
 * orchestrator drain 重启存在约 5-15s 的连接拒绝空窗（自退 → systemd
 * RestartSec=5 拉起 + 启动耗时），累计 10s 退避基本覆盖。
 */
const DEFAULT_CONNECT_RETRY_BACKOFF_MS = [1_000, 3_000, 6_000];

/** 可被 AbortSignal 打断的 sleep；abort 时 reject AbortError（外层按既有 aborted 分支归一化）。 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface HttpTransportOptions {
  /** hand-server base URL，例如 `http://127.0.0.1:3300`。 */
  baseUrl: string;
  /** server-to-hand 鉴权 token；远端校验 Authorization Bearer。 */
  authToken: string;
  /**
   * HTTP fetch 的整体超时（毫秒）；超时会 abort 并返回 error response。
   * 不影响 hand 端工具自己的 timeoutMs（在 input 里独立传递）。
   * Default 60 秒。
   */
  invokeTimeoutMs?: number;
  /**
   * Hand 端公示的工具集合。Brain 端在构造时已知契约，不从远端拉 schema。
   * 默认 `WORKSPACE_HAND_TOOLS`（workspace hand 的标准工具集合）。
   */
  internalTools?: ToolDescriptor[];
  /** 测试注入用的 fetch 实现；生产环境为全局 fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 连接类瞬时失败（建连网络错误 / HTTP 503）的重试退避序列（毫秒）。
   * 默认 [1s, 3s, 6s]；传 [] 关闭重试。测试可传小值。
   */
  connectRetryBackoffMs?: number[];
  /**
   * 每次 invoke 前调用，按 workspace 装配一份要透传给远端 hand 的 env（wire.context.env）。
   * 只能返回 {@link HAND_ENV_ALLOWLIST} 内的 key（未上 allowlist 的会被 pickHandEnv 剥掉）；
   * 未配置或返回空对象 → wire 不带 env（远端 pod 只有自身 K8s spec 里的 env）。
   *
   * 典型用法：闭包捕获当前会话 tenantId，内部调 resolveAzerothInjection(tenantId, ws.username)
   * 得到 { AZEROTH_TOKEN, AZEROTH_API_URL }。见 rawRuntimeRunDispatch.ts。
   */
  envResolver?: (workspace: WorkspaceRef) => Record<string, string | undefined>;
}

/**
 * 跨进程 HTTP transport：把 ToolInvocationRequest 序列化后 POST 到独立的 hand-server。
 *
 * PR 1.4 + 1.5 引入。配合 monorepo 内的 `hand-server/` 子包使用。
 *
 * 关键序列化策略（与 PR 1.5 workspaceId 化对齐）：
 * - **workspace.root 不上线**：远端 hand 有自己的 `workspaceResolver`，
 *   按 `workspace.id` 解析到 hand 端本地 sandbox 路径。brain 端的本地路径对
 *   远端没有意义、还可能泄露 host 信息。
 * - **AbortSignal 不序列化**：透传给 `fetch(... { signal })`；调用方 abort
 *   → 连接 RST → 远端 hand 内置 watcher 自然 cleanup（PoC 不实装跨进程 cancel
 *   协议，依赖 HTTP 半双工的连接断开语义）。
 * - **invokeTimeoutMs**：fetch 整体兜底超时；hand 端工具自己的 timeoutMs 在
 *   input 内独立传递，不与本字段冲突。
 *
 * 错误归一化：fetch 抛错 / HTTP 非 2xx / 业务 error → 统一返回
 * `{ status: 'error', error, audit?, metadata? }`，让上层 WorkspaceToolProvider
 * 像处理本地 transport 一样处理。
 *
 * 见 `assets/20260607/Managed-Agents架构-完整路线规划.md` §7.3 PR 1.4 / §7.2。
 */
export class HttpTransport implements ExecutionTransport {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly invokeTimeoutMs: number;
  private readonly internalTools: ToolDescriptor[];
  private readonly fetchImpl: typeof fetch;
  private readonly envResolver?: (workspace: WorkspaceRef) => Record<string, string | undefined>;
  private readonly connectRetryBackoffMs: number[];

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.authToken = options.authToken;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    this.internalTools = options.internalTools ?? WORKSPACE_HAND_TOOLS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.envResolver = options.envResolver;
    this.connectRetryBackoffMs = options.connectRetryBackoffMs ?? DEFAULT_CONNECT_RETRY_BACKOFF_MS;
  }

  /**
   * 连接类瞬时失败重试（2026-07-15 零停机部署批次）。
   * 只对两类失败重试，语义安全（请求未被对端执行）：
   * - fetch 建连抛错（ECONNREFUSED 等网络错误，请求未到达对端）
   * - HTTP 503（orchestrator drain 期间拒新请求返回 503+retry-after，handler 未执行）
   * 其余（超时 abort / 调用方 abort / 4xx / 其他 5xx / 流中途断开）一律不重试，
   * 避免重复副作用。等待期间 signal abort → 抛 AbortError，走外层既有 aborted 分支。
   */
  private async fetchWithConnectRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const backoffs = this.connectRetryBackoffMs;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (err) {
        if (signal?.aborted || attempt >= backoffs.length) throw err;
        await sleepAbortable(backoffs[attempt]!, signal);
        continue;
      }
      if (response.status === 503 && attempt < backoffs.length && !signal?.aborted) {
        // 释放未消费的连接，再按 retry-after（不超过本档退避）等待重试
        void response.body?.cancel().catch(() => undefined);
        const retryAfterSec = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, backoffs[attempt]!)
          : backoffs[attempt]!;
        await sleepAbortable(waitMs, signal);
        continue;
      }
      return response;
    }
  }

  /**
   * 装配 wire.context.env。envResolver 返回值先经 pickHandEnv allowlist 二次过滤，
   * 保证任何 slip-through 的敏感 env 都不会上 wire。空对象则不写字段（wire 更紧凑）。
   */
  private resolveWireEnv(workspace: WorkspaceRef): Record<string, string> | undefined {
    if (!this.envResolver) return undefined;
    let raw: Record<string, string | undefined>;
    try {
      raw = this.envResolver(workspace) ?? {};
    } catch {
      return undefined;
    }
    const picked = pickHandEnv(raw);
    return Object.keys(picked).length > 0 ? picked : undefined;
  }

  listInternalTools(): ToolDescriptor[] {
    return this.internalTools;
  }

  async health(): Promise<{ status: 'ok' | 'unhealthy'; detail?: string; metadata?: Record<string, unknown> }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`);
      if (!response.ok) return { status: 'unhealthy', detail: `HTTP ${response.status}` };
      const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      return { status: body?.status === 'ok' ? 'ok' : 'unhealthy', metadata: body };
    } catch (err) {
      return { status: 'unhealthy', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async discoverTools(): Promise<ToolDescriptor[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/tools`);
      if (!response.ok) return this.internalTools;
      const body = await response.json() as { tools?: Array<Partial<ToolDescriptor> & { name?: string }> };
      const byName = new Map(this.internalTools.map((tool) => [tool.name, tool]));
      return (body.tools ?? []).map((tool) => byName.get(String(tool.name)) ?? null).filter((tool): tool is ToolDescriptor => Boolean(tool));
    } catch {
      return this.internalTools;
    }
  }

  async provision(recipe: WorkspaceRecipe): Promise<{ status: 'ok' | 'error'; error?: string; metadata?: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.invokeTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchWithConnectRetry(`${this.baseUrl}/provision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ workspaceId: recipe.workspaceId, recipe }),
        signal: controller.signal,
      }, controller.signal);
      const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (!response.ok) {
        return {
          status: 'error',
          error: `hand-server provision HTTP ${response.status}: ${typeof body?.error === 'string' ? body.error : 'no body'}`,
          metadata: body,
        };
      }
      return { status: body?.status === 'ok' ? 'ok' : 'error', metadata: body };
    } catch (err) {
      if (controller.signal.aborted) return { status: 'error', error: `hand-server provision 超时 (${this.invokeTimeoutMs}ms)` };
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async invoke(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    if (this.shouldUseStreaming(request)) {
      let finalResponse: ToolInvocationResponse | null = null;
      for await (const chunk of this.invokeStream(request)) {
        if (chunk.type === 'completed') finalResponse = chunk.response;
      }
      return finalResponse ?? { status: 'error', error: 'hand-server stream ended without completed chunk' };
    }
    const wireRequest = this.buildWireRequest(request);
    const upstreamSignal = request.context.signal;

    // 用 AbortController 同时承载"调用方 abort"与"transport 超时"两个来源。
    const controller = new AbortController();
    const onUpstreamAbort = () => {
      controller.abort();
      void this.cancelInvocation(request.context.invocationId);
    };
    upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true });
    const streamTimeoutMs = Math.max(this.invokeTimeoutMs, toolTimeoutMs(request) + 5_000);
    const timer = setTimeout(() => {
      controller.abort();
      void this.cancelInvocation(request.context.invocationId);
    }, streamTimeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchWithConnectRetry(`${this.baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(wireRequest),
        signal: controller.signal,
      }, controller.signal);

      if (response.status === 401 || response.status === 403) {
        return {
          status: 'error',
          error: `hand-server 鉴权失败 (HTTP ${response.status})`,
        };
      }

      if (!response.ok) {
        const text = await safeText(response);
        return {
          status: 'error',
          error: `hand-server HTTP ${response.status}: ${text || 'no body'}`,
        };
      }

      const body = await response.json() as unknown;
      const parsed = parseToolInvocationResponse(body);
      if (!parsed) {
        return {
          status: 'error',
          error: 'hand-server 返回的 body 不是合法 ToolInvocationResponse',
        };
      }
      return parsed;
    } catch (err) {
      if (upstreamSignal?.aborted) {
        return {
          status: 'error',
          error: 'hand-server 调用被调用方 abort',
          metadata: { aborted: true },
        };
      }
      if (controller.signal.aborted) {
        return {
          status: 'error',
          error: `hand-server 调用超时 (${this.invokeTimeoutMs}ms)`,
          metadata: { timedOut: true },
        };
      }
      return {
        status: 'error',
        error: `hand-server 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort);
    }
  }

  invokeStream(request: ToolInvocationRequest): ToolInvocationStream {
    return this.invokeStreamInternal(request);
  }

  private async *invokeStreamInternal(request: ToolInvocationRequest): ToolInvocationStream {
    const wireRequest = this.buildWireRequest(request);
    const upstreamSignal = request.context.signal;
    const controller = new AbortController();
    const onUpstreamAbort = () => {
      controller.abort();
      void this.cancelInvocation(request.context.invocationId);
    };
    upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true });
    const streamTimeoutMs = Math.max(this.invokeTimeoutMs, toolTimeoutMs(request) + 5_000);
    const timer = setTimeout(() => {
      controller.abort();
      void this.cancelInvocation(request.context.invocationId);
    }, streamTimeoutMs);
    timer.unref?.();
    try {
      // 重试仅发生在建连失败/503（此时必然还没收到任何 chunk）；流一旦建立，
      // 中途断开不重试（对端可能已产生副作用）。
      const response = await this.fetchWithConnectRetry(`${this.baseUrl}/execute-stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(wireRequest),
        signal: controller.signal,
      }, controller.signal);
      if (!response.ok || !response.body) {
        const text = await safeText(response);
        yield { type: 'completed', response: { status: 'error', error: `hand-server stream HTTP ${response.status}: ${text || 'no body'}` } };
        return;
      }
      let sawCompleted = false;
      for await (const chunk of parseSseStream(response.body)) {
        if (chunk.type === 'completed') sawCompleted = true;
        yield chunk;
      }
      if (!sawCompleted) {
        yield { type: 'completed', response: { status: 'error', error: 'hand-server stream ended without completed chunk' } };
      }
    } catch (err) {
      yield {
        type: 'completed',
        response: upstreamSignal?.aborted
          ? { status: 'error', error: 'hand-server stream 被调用方 abort', metadata: { aborted: true } }
          : controller.signal.aborted
            ? { status: 'error', error: `hand-server stream 超时 (${streamTimeoutMs}ms)`, metadata: { timedOut: true } }
            : { status: 'error', error: `hand-server stream 调用失败: ${err instanceof Error ? err.message : String(err)}` },
      };
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort);
    }
  }

  /**
   * 走实例的 wire 序列化：free-function serializeRequest 只组装静态字段，
   * 这里额外把 envResolver 装配的 wire env（allowlist 过滤后）挂上。
   */
  private buildWireRequest(request: ToolInvocationRequest): WireToolInvocationRequest {
    const base = serializeRequest(request);
    const env = this.resolveWireEnv(request.context.workspace);
    if (!env) return base;
    return {
      ...base,
      context: {
        ...base.context,
        env,
      },
    };
  }

  private shouldUseStreaming(request: ToolInvocationRequest): boolean {
    const mode = request.input && typeof request.input === 'object'
      ? (request.input as { mode?: unknown }).mode
      : undefined;
    return Boolean(request.context.invocationId && request.toolName === 'Shell' && mode !== 'background');
  }

  private async cancelInvocation(invocationId: string | undefined): Promise<void> {
    if (!invocationId) return;
    await this.fetchImpl(`${this.baseUrl}/invocations/${encodeURIComponent(invocationId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.authToken}` },
    }).catch(() => undefined);
  }
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<ToolInvocationStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bufferedBytes = 0;
  const drainFrame = function* (frame: string): Iterable<ToolInvocationStreamChunk> {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    try {
      yield JSON.parse(data) as ToolInvocationStreamChunk;
    } catch (err) {
      yield {
        type: 'completed',
        response: { status: 'error', error: `hand-server stream returned malformed SSE JSON: ${err instanceof Error ? err.message : String(err)}` },
      };
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bufferedBytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    if (bufferedBytes > MAX_SSE_BUFFER_BYTES) {
      yield {
        type: 'completed',
        response: { status: 'error', error: `hand-server stream frame exceeded ${MAX_SSE_BUFFER_BYTES} bytes` },
      };
      await reader.cancel().catch(() => undefined);
      return;
    }
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? '';
    bufferedBytes = new TextEncoder().encode(buffer).byteLength;
    for (const frame of parts) {
      for (const chunk of drainFrame(frame)) {
        yield chunk;
        if (chunk.type === 'completed') {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const chunk of drainFrame(buffer)) {
      yield chunk;
      if (chunk.type === 'completed') return;
    }
  }
}

/**
 * 将 ToolInvocationRequest 转成线上可序列化的 wire 形态。
 *
 * - 丢掉 AbortSignal（不可 JSON.stringify）
 * - 丢掉 workspace.root（brain-local，远端不需要）
 *
 * 导出供 hand-server 端测试 / parsing 对照。
 */
export function serializeRequest(request: ToolInvocationRequest): WireToolInvocationRequest {
  const ws = request.context.workspace;
  const wireWorkspace: WireWorkspaceRef = {
    id: ws.id,
    userId: ws.userId,
    username: ws.username,
    sessionId: ws.sessionId,
    sandboxScopeId: ws.sandboxScopeId,
    mountSubPath: ws.mountSubPath,
    executionTarget: ws.executionTarget,
  };
  return {
    toolName: request.toolName,
    input: request.input,
    context: {
      ...(request.context.invocationId ? { invocationId: request.context.invocationId } : {}),
      ...(request.context.handId ? { handId: request.context.handId } : {}),
      workspace: wireWorkspace,
    },
  };
}

export interface WireWorkspaceRef extends Omit<WorkspaceRef, 'root'> {
  /** id 仍然是 optional 与 WorkspaceRef 一致（向后兼容当前 LocalWorkspaceProvider 输出）。 */
  id?: string;
}

export interface WireToolInvocationRequest {
  toolName: string;
  input: unknown;
  context: {
    invocationId?: string;
    handId?: string;
    workspace: WireWorkspaceRef;
    /**
     * 显式透传给远端 hand 的 env（K/V），仅限 {@link HAND_ENV_ALLOWLIST} 内的 key。
     * 缺省 = 不透传（远端 pod 只有自己 K8s spec 内的 env）。
     * 服务端 parseWireRequest 会再做一次 allowlist 剥离，防御客户端漏筛。
     */
    env?: Record<string, string>;
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseToolInvocationResponse(body: unknown): ToolInvocationResponse | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (obj.status === 'success' && typeof obj.content === 'string') {
    return {
      status: 'success',
      content: obj.content,
      audit: Array.isArray(obj.audit) ? obj.audit as ToolInvocationResponse['audit'] : undefined,
      metadata: typeof obj.metadata === 'object' && obj.metadata !== null
        ? obj.metadata as Record<string, unknown>
        : undefined,
    };
  }
  if (obj.status === 'error' && typeof obj.error === 'string') {
    return {
      status: 'error',
      error: obj.error,
      audit: Array.isArray(obj.audit) ? obj.audit as ToolInvocationResponse['audit'] : undefined,
      metadata: typeof obj.metadata === 'object' && obj.metadata !== null
        ? obj.metadata as Record<string, unknown>
        : undefined,
    };
  }
  return null;
}

function toolTimeoutMs(request: ToolInvocationRequest): number {
  const input = request.input;
  if (input && typeof input === 'object' && typeof (input as { timeoutMs?: unknown }).timeoutMs === 'number') {
    return (input as { timeoutMs: number }).timeoutMs;
  }
  return 0;
}

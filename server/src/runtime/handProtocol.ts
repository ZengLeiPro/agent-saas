import type { ExecutionInvocationAudit, WorkspaceRef } from '../agent/toolRuntime.js';

/**
 * 单次工具调用的请求 envelope。
 *
 * 替代现有 ExecutionProvider 的 4 方法接口（readFile/writeFile/listFiles/runShell），
 * 按 Managed Agents 形态收敛为统一 `execute(name, input)` 形态。
 * 这是 hand 可以是 container / phone / emulator 的前提——后两者没有 readFile 语义但有 screenshot/tap。
 *
 * 见 `assets/20260607/Managed-Agents架构-完整路线规划.md` §2 / §7。
 *
 * 演化点（不在 PR 1.1 内实施，仅留接口入口）：
 * - PR 1.2：ExecutionProvider 实现按本 envelope dispatch；本类型即正式接口入口。
 * - PR 1.5：`WorkspaceRef` 拆分为 brain 侧的 `workspaceId` 元数据 + 每个 hand 自己的 localPath 解析器，
 *   本 envelope 的 `context.workspace` 字段会跟随更名。
 */
export interface ToolInvocationRequest {
  /** 工具标识，由 hand 的 `listInternalTools()` 对外公示（例如 `'Read'` / `'Write'`）。 */
  toolName: string;
  /** 工具入参；结构由该工具自己的 schema 决定，envelope 不做类型收敛。 */
  input: unknown;
  /** 调用上下文。 */
  context: ToolInvocationContext;
}

export interface ToolInvocationContext {
  /** Durable invocation id used for streaming/cancel correlation across brain and hand. */
  invocationId?: string;
  /** Optional durable hand id for many-hands routing. */
  handId?: string;
  /**
   * Workspace 引用。
   * 当前形态下 `root` 仍是 brain 本地绝对路径；PR 1.5 落地"workspace 三方角色"心智后
   * （§7.2），这里会替换为 `workspaceId`（brain 侧元数据）+ hand 端自己的解析器。
   */
  workspace: WorkspaceRef;
  /**
   * AbortSignal。
   * InProcessTransport 直接透传给底层 ExecutionProvider；HttpTransport（PR 1.4）落地时需要单独的
   * 跨进程取消协议（例如握手时分配一个 `invocationId` + `DELETE /invocations/:id`），
   * 本字段不会被直接序列化到线上。
   */
  signal?: AbortSignal;
}

/**
 * 工具调用的结果 envelope。
 *
 * 替代现有 ExecutionProvider 4 个方法各自的 `Promise<string>` / `Promise<void>` 返回类型，
 * 统一为 `{ status, content/error, audit, metadata }`——让远端 transport 一次回传执行结果与
 * 结构化审计明细，brain 侧不再依赖"调用现场注入的 ExecutionAuditRecorder"。
 *
 * 审计采集方式的演化：
 * - 当前（PR 1.1 前）：`ToolCallContext.executionAudit` 是一个 in-process recorder，
 *   ExecutionProvider 直接 push 到 brain 侧的数组里。
 * - PR 1.2 起：hand 侧自己收集，调用结束随本 response 的 `audit` 字段一并返回；
 *   远程 hand 也是同一形态。
 */
export type ToolInvocationResponse =
  | {
      status: 'success';
      /** 返回给模型的文本载荷（对齐现有 `ToolResult.content`）。 */
      content: string;
      /** Hand 端产生的结构化审计记录（容器 exec 明细等）。 */
      audit?: ExecutionInvocationAudit[];
      /** 选填的结构化元数据（写入字节数、解析后的实际路径等）。 */
      metadata?: Record<string, unknown>;
    }
  | {
      status: 'error';
      /** 失败原因，将作为 tool_result 写入 transcript。 */
      error: string;
      /** 失败前可能已经产生的部分审计记录（例如 Shell 启动成功后被 abort）。 */
      audit?: ExecutionInvocationAudit[];
      /** 选填的结构化元数据（`exitCode` / `timedOut` / `aborted` 等）。 */
      metadata?: Record<string, unknown>;
    };

/**
 * 流式调用的单个 chunk。
 *
 * 阶段 1 不实装（见 §7.5 R2 / §10 决策表"长任务 streaming 推到阶段 2"），
 * 类型先在此预留，让 PR 1.4 HttpTransport 与阶段 2 EventStore streaming 后续能共享同一 envelope，
 * 避免接口形态二次破坏。
 *
 * 设计约束：流的最后一个 chunk 必须是 `completed`，携带最终的 `ToolInvocationResponse`，
 * 这样消费方可以用同一形态接收"非流式"与"流式"的最终结果。
 */
export type ToolInvocationStreamChunk =
  | { type: 'output'; channel: 'stdout' | 'stderr'; content: string }
  | { type: 'progress'; message: string }
  | { type: 'completed'; response: ToolInvocationResponse };

/**
 * 流式调用别名：AsyncIterable<ToolInvocationStreamChunk>，最后一个 chunk 为 `completed`。
 */
export type ToolInvocationStream = AsyncIterable<ToolInvocationStreamChunk>;

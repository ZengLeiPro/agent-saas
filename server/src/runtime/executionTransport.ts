import type { ExecutionTargetKind, ToolDescriptor } from '../agent/toolRuntime.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
  ToolInvocationStream,
} from './handProtocol.js';

/**
 * Hand 接入层抽象——把"工具调用形态"与"hand 部署位置"解耦。
 *
 * - `InProcessTransport`（PR 1.3）：直接调本进程内的 ExecutionProvider，零开销。
 * - `HttpTransport`（PR 1.4）：跨进程 HTTP 调远端 hand server，开启 `'server-remote'` target。
 * - `WebSocketReverseTransport`（阶段 3）：客户机器 daemon 反向接入 brain，应对 NAT 后场景。
 *
 * Transport 边界让"同一份 hand 代码可以本进程跑、远端 sidecar 跑、客户机器 daemon 跑"成为可能。
 *
 * 见 `assets/20260607/Managed-Agents架构-完整路线规划.md` §2 / §7.3 PR 1.3-1.5。
 */
export interface ExecutionTransport {
  /**
   * 单次调用。返回完整 `ToolInvocationResponse`。
   *
   * 长任务的流式输出走 `invokeStream`（阶段 1 不实装；阶段 2 引入 EventStore streaming 时一并落地）。
   */
  invoke(request: ToolInvocationRequest): Promise<ToolInvocationResponse>;

  /**
   * 可选的流式调用。
   *
   * 阶段 1 不实装——任何 transport 当前都不需要实现本方法。接口先预留是为了让
   * PR 1.4 HttpTransport 与阶段 2 长任务 streaming 后续直接 opt-in，不再改 transport 接口。
   *
   * 见 §7.5 R2 / §10 决策表。
   */
  invokeStream?(request: ToolInvocationRequest): ToolInvocationStream;

  /**
   * Hand 端对外暴露的工具集合。
   *
   * - Workspace hand 暴露 `Read / Write / List / Shell`。
   * - 假想的"手机 hand"则暴露 `screenshot / tap / swipe` 之类。
   *
   * PR 1.2 让 `ExecutionProvider` 实现通过本方法对外公示工具描述符；
   * `PlatformToolRuntime` 汇总各 transport 的 `listInternalTools()` 后通过 `invoke` 分发。
   */
  listInternalTools(): ToolDescriptor[];
}

/**
 * Transport 注册表，替代当前的 `ExecutionProviderRegistry`。
 *
 * - PR 1.3 引入（只有 InProcess 一种 transport，行为零变化）。
 * - PR 1.4 加入 HTTP transport，`ExecutionTargetKind` 同步扩展出 `'server-remote'`。
 * - 阶段 3 加入客户 daemon 反向连接 transport。
 */
export interface ExecutionTransportRegistry {
  has(target: ExecutionTargetKind): boolean;
  get(target: ExecutionTargetKind): ExecutionTransport;
  register(target: ExecutionTargetKind, transport: ExecutionTransport): void;
}

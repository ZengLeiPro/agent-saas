import type {
  ExecutionProvider,
  ExecutionTargetKind,
  ToolDescriptor,
} from '../agent/toolRuntime.js';
import type {
  ExecutionTransport,
  ExecutionTransportRegistry,
} from './executionTransport.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
  ToolInvocationStream,
} from './handProtocol.js';

/**
 * 零开销 in-process transport：直接调本进程内的 ExecutionProvider。
 *
 * PR 1.3 引入。让 PlatformToolRuntime 永远通过 ExecutionTransport 接口调 hand——
 * 不区分"本进程 provider"还是"远端 hand server"。这样 PR 1.4 HttpTransport 上线时，
 * PlatformToolRuntime 一行不动就能切到远端。
 *
 * 见 `assets/20260607/Managed-Agents架构-完整路线规划.md` §7.3 PR 1.3。
 *
 * 实施约束：本文件仅 type-only 引用 `ExecutionProvider` / `ExecutionTargetKind`
 * 以避免与 `agent/toolRuntime.ts` 形成循环 import；具体 provider 实例的装配
 * 在 toolRuntime.ts 的 `createDefaultExecutionTransportRegistry()` 中完成。
 */
export class InProcessTransport implements ExecutionTransport {
  constructor(private readonly provider: ExecutionProvider) {}

  invoke(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    return this.provider.execute(request);
  }

  invokeStream(request: ToolInvocationRequest): ToolInvocationStream {
    return this.provider.executeStream ? this.provider.executeStream(request) : fallbackInvokeStream(this.provider.execute(request));
  }

  listInternalTools(): ToolDescriptor[] {
    return this.provider.listInternalTools();
  }
}

/**
 * Transport 注册表的默认实装。
 *
 * 替代原 `DefaultExecutionProviderRegistry`。键仍是 `ExecutionTargetKind`，
 * PR 1.4 加入 `'server-remote'` 时不破坏现有路由结构。
 */
export class DefaultExecutionTransportRegistry implements ExecutionTransportRegistry {
  private readonly transports = new Map<ExecutionTargetKind, ExecutionTransport>();

  constructor(entries: Array<[ExecutionTargetKind, ExecutionTransport]> = []) {
    for (const [target, transport] of entries) {
      this.register(target, transport);
    }
  }

  has(target: ExecutionTargetKind): boolean {
    return this.transports.has(target);
  }

  get(target: ExecutionTargetKind): ExecutionTransport {
    const transport = this.transports.get(target);
    if (!transport) {
      throw new Error(`Execution transport not registered: ${target}`);
    }
    return transport;
  }

  register(target: ExecutionTargetKind, transport: ExecutionTransport): void {
    this.transports.set(target, transport);
  }
}

async function* fallbackInvokeStream(response: Promise<ToolInvocationResponse>): ToolInvocationStream {
  yield { type: 'completed', response: await response };
}

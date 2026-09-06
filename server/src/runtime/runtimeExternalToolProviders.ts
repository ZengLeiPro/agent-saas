/**
 * 外部系统工具 provider 的统一装配（MCP + 定制项目能力）。
 *
 * 从 `collectRuntimeTooling`（`rawRuntimeRunDispatch.ts`）外提：那个文件顶在
 * max-lines 棘轮上（2996 行），WP3 要在同一位置再挂一个 provider，只能等行数替换。
 *
 * 两个 provider 的共同点，也是它们放在一起的理由：
 * - 都是「远端声明、本地投影」的动态工具，`list()` 同步读 cache、`warmup()` 异步预热；
 * - 预热失败都**不得**阻断主路径（本轮少几个工具，而不是整个 run 挂掉）；
 * - 都必须在 `AgentToolProvider` 之前 push —— 子 Agent 的工具集从 parentProviders
 *   快照派生，push 顺序决定子 Agent 能不能看到它们。
 */
import { getAppCapabilityGateway } from '../kyapp/gateway/runtimeBinding.js';
import { McpClientToolProvider } from '../mcp/clientToolProvider.js';

import type { ToolProvider } from '../agent/toolRuntime.js';
import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';

/**
 * 预热上下文。四个 `collectRuntimeTooling` 调用方（首跑 / 审批恢复 / 交互恢复 /
 * 后台任务）都必须传，漏一处 = 恢复路径上没有 `app__` 工具，`prompt_cache_key` 会抖。
 */
export interface RuntimeToolWarmupContext {
  runId: string;
  sessionId: string;
  userId: string;
  /** 定制项目能力快照必需；缺失即不投影 `app__` 工具。 */
  tenantId?: string;
}

export async function pushExternalToolProviders(input: {
  providers: ToolProvider[];
  config: Pick<RawRuntimeRunDispatchConfig, 'mcpProxy' | 'mcpClientManager'>;
  username: string | undefined;
  warmupContext: RuntimeToolWarmupContext | undefined;
}): Promise<void> {
  const { providers, config, username, warmupContext } = input;

  // 6. MCP 工具（带超时兜底，单 server hang 不会卡 dispatch 主路径）
  if (config.mcpProxy || config.mcpClientManager) {
    const mcpProvider = new McpClientToolProvider(config.mcpProxy ?? config.mcpClientManager!);
    try {
      await mcpProvider.warmup({ username, ...(warmupContext ?? {}) });
    } catch {
      // MCP 预热失败只影响本轮 MCP tool schema，不阻断主路径。
    }
    providers.push(mcpProvider);
  }

  // 6.2 定制项目能力（WP3，规范 §6.1）。会话快照按 (sessionId, installationId,
  // registeredDigest) 冻结，恢复路径读的是同一份，因此工具指纹逐字节稳定。
  const gateway = getAppCapabilityGateway();
  if (gateway && warmupContext?.tenantId) {
    try {
      await gateway.provider.warmup({
        sessionId: warmupContext.sessionId,
        tenantId: warmupContext.tenantId,
        userId: warmupContext.userId,
        runId: warmupContext.runId,
      });
    } catch {
      // fail-static 由 snapshot service 承担；这里只保证预热异常不阻断主路径。
    }
    providers.push(gateway.provider);
  }
}

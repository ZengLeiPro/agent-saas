#!/usr/bin/env tsx
/**
 * notify-drop-multiprocess chaos：在真分离 ws-only + scheduler-only 拓扑下，
 * 等远端 hand tool 开始执行后，从外部杀掉 ws 进程的 PG LISTEN backend
 * （pg_terminate_backend），模拟 PG NOTIFY 通道中断。断言：subscribeAppended
 * 自动重连 + catch-up 后，ws 客户端仍能收到完整 tool_result + final text + done，
 * 无 silent loss，且终态 done 只发一次。
 *
 * 覆验 chaos-gate Phase 1 修的 defect B（pgEventStore.subscribeAppended 重连
 * + catchup + 水位）在真实分离拓扑下也成立——单元级真实 PG 测试已覆盖单进程，
 * 这是首个真实多进程版本。
 */
import { runScenario } from './verify-runtime-multiprocess-e2e.mts';

void runScenario('notify-drop').catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * db-unavailable-multiprocess chaos：在真分离 ws-only + scheduler-only 拓扑下，
 * 等远端 hand tool 开始执行后，docker pause PG 容器 2s 再 unpause，模拟 DB
 * 短暂不可用。断言：① scheduler.tick 与 lease.renew 熬过 blip；
 * ② subscribeAppended 自愈；③ run 最终完成且只完成一次，ws 客户端收到完整
 * tool_result + final text + done。
 *
 * 覆验 chaos-gate Phase 1 修的 defect A（runStore terminal-sink 守卫）+ defect B
 * 在真实分离拓扑下也成立——单元级真实 PG 测试已覆盖单进程，这是首个真实多进程版本。
 */
import { runScenario } from './verify-runtime-multiprocess-e2e.mts';

void runScenario('db-unavailable').catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

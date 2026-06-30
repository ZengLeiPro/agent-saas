#!/usr/bin/env tsx
/**
 * scheduler-restart-multiprocess chaos：在真分离 ws-only + scheduler-only 拓扑下，
 * 等远端 hand tool 开始执行后，SIGKILL scheduler-only A 进程，让其 lease 自然过期；
 * 然后 spawn 第二个 scheduler-only B，断言：① B 接管 lease；② run 最终收敛到唯一
 * terminal done（terminal-sink 守卫 + scheduler.stop drain + lease expiry 保证幂等，
 * 不产生重复 wake / 重复 done）。
 *
 * 覆验 chaos Phase 1 修的 defect A（runStore terminal-sink guard）+ 多 brain lease
 * 接管语义在真实分离拓扑下也成立——单元级 multi-worker chaos 已覆盖单进程共享 PG
 * 场景，这是首个真实多进程 kill+restart 版本。
 */
import { runScenario } from './verify-runtime-multiprocess-e2e.mts';

void runScenario('scheduler-restart').catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * hand-kill-multiprocess chaos：在真分离 ws-only + scheduler-only 拓扑下，
 * 等远端 hand tool 开始执行后，SIGKILL hand-server 进程。断言：ws 客户端收到
 * 唯一终态 done/error，scheduler 不卡 lease，run 不悬挂。
 *
 * 把已有的 hand chaos 入口（组件级 HttpTransport.invoke）升级为真实 WebSocket
 * chat → enqueue → scheduler wake → server-remote hand → SIGKILL hand → 用户
 * 可见 terminal 投影 done。覆验在真实多进程拓扑下，hand failure 能干净地反映
 * 到 user-facing done/error 而不是 silent hang。
 */
import { runScenario } from './verify-runtime-multiprocess-e2e.mts';

void runScenario('hand-kill').catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

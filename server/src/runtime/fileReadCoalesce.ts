/**
 * FD 治理工具：in-flight readFile 去重 + 轻量 Semaphore。
 *
 * 背景：raw runtime 的 EventStore / ApprovalStore 都走 `readFile` 原子调用，
 * 多个 WS 会话并发触发 audit / approval resume 时，瞬时打开同名 jsonl 的次数
 * 与活跃 chat 数成正比，macOS 默认 fd 上限会被打穿，表现为 EMFILE。
 *
 * 两个原语都不引入新依赖、不依赖任何外部状态：
 * - `readFileCoalesce`: 同一 filePath 上正在进行的 readFile 共享同一个 Promise，
 *   N 并发只会触发 1 次 syscall；ENOENT 静默返回 null（与上层旧约定一致）。
 *   完成后立即从 in-flight map 删除，**不做内容 TTL 缓存**——避免 append 之后
 *   下一次 list 读到旧内容，事实源始终是磁盘。
 * - `Semaphore`: 经典 promise-based，acquire 返回 release 函数。
 *   仅用于跨文件 / 跨函数的并发兜底（dedup 只能解决"同文件"那一维）。
 */

import { readFile } from 'fs/promises';

const inFlightReads = new Map<string, Promise<string | null>>();

// 仅供测试观察：累计触发的实际 readFile 次数。
// 生产路径上的开销 = 1 次 ++，可忽略；ESM 下 vi.spyOn 不可用，必须靠内部计数器。
let syscallCounter = 0;

/**
 * 同一 filePath 的并发 readFile 共享 in-flight promise，N→1 syscall。
 * ENOENT → null。其他错误透传。
 */
export async function readFileCoalesce(filePath: string): Promise<string | null> {
  const existing = inFlightReads.get(filePath);
  if (existing) return existing;
  const promise = (async () => {
    syscallCounter++;
    try {
      return await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw err;
    }
  })();
  inFlightReads.set(filePath, promise);
  try {
    return await promise;
  } finally {
    // 完成（成功/失败）即删除，下一次调用走新 syscall，保证事实源仍是磁盘。
    if (inFlightReads.get(filePath) === promise) {
      inFlightReads.delete(filePath);
    }
  }
}

/** 仅在测试中使用：清空 in-flight 状态 + 重置 syscall 计数。 */
export function __resetFileReadCoalesceForTests(): void {
  inFlightReads.clear();
  syscallCounter = 0;
}

/** 仅在测试中使用：观察实际触发的 readFile 次数。 */
export function __getReadFileCoalesceSyscallsForTests(): number {
  return syscallCounter;
}

/**
 * 经典 promise-based semaphore。
 * acquire() 返回 release 函数；release 幂等。
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max <= 0) {
      throw new Error(`Semaphore: max must be a positive integer, got ${max}`);
    }
    this.permits = max;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return this.makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        resolve(this.makeRelease());
      });
    });
  }

  /** 当前可用 permits（仅供测试 / 监控用）。 */
  available(): number {
    return this.permits;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.permits++;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

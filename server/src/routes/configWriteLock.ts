import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export function configRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class ConfigWriteConflictError extends Error {
  constructor(message = '配置正在被并发修改，请刷新后重试') {
    super(message);
    this.name = 'ConfigWriteConflictError';
  }
}

/**
 * 跨进程 config.json 写锁。管理写入很短；锁已占用时直接拒绝，避免阻塞事件循环。
 */
export function withConfigWriteLock<T>(configPath: string, action: () => T): T {
  const lockPath = `${configPath}.admin-write.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigWriteConflictError();
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function replaceConfigAtomically(configPath: string, updatedText: string): void {
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  const mode = statSync(configPath).mode & 0o777;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx', mode);
    writeFileSync(descriptor, updatedText, 'utf-8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // 同目录 rename：写入或完整可见，或旧文件保持不变，不产生截断中间态。
    renameSync(tempPath, configPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(tempPath); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

export function writeConfigIfUnchanged(configPath: string, expectedText: string, updatedText: string): void {
  withConfigWriteLock(configPath, () => {
    if (readFileSync(configPath, 'utf-8') !== expectedText) throw new ConfigWriteConflictError();
    replaceConfigAtomically(configPath, updatedText);
  });
}

/**
 * 可跨 await 持有的管理端写锁。异步 prepare/apply 必须使用这个版本，不能把
 * Promise 返回给同步 withConfigWriteLock（后者会在 Promise settle 前释放锁）。
 */
export async function withConfigWriteLockAsync<T>(
  configPath: string,
  action: () => Promise<T> | T,
): Promise<T> {
  const lockPath = `${configPath}.admin-write.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigWriteConflictError();
    throw error;
  }
  try {
    return await action();
  } finally {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * 管理配置的两阶段发布：锁内先做执行侧 apply，再次 CAS 后才落盘。apply 或 CAS
 * 失败时用旧快照 rollback；因此失败候选不会出现在 config.json，也不会覆盖在
 * prepare 期间出现的并发胜出版本。
 */
export async function publishConfigIfUnchanged(
  configPath: string,
  expectedText: string,
  updatedText: string,
  apply?: () => Promise<void> | void,
  rollback?: () => Promise<void> | void,
  replace: (path: string, text: string) => void = replaceConfigAtomically,
): Promise<void> {
  await withConfigWriteLockAsync(configPath, async () => {
    if (readFileSync(configPath, 'utf-8') !== expectedText) throw new ConfigWriteConflictError();

    let applyAttempted = false;
    try {
      if (apply) {
        applyAttempted = true;
        await apply();
      }
      // apply 可能跨越 SecretVault/运行时 prepare；提交前必须仍以同一版本为基线。
      if (readFileSync(configPath, 'utf-8') !== expectedText) throw new ConfigWriteConflictError();
      replace(configPath, updatedText);
    } catch (error) {
      if (applyAttempted && rollback) {
        try {
          await rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], '配置发布失败，且执行侧回滚失败');
        }
      }
      throw error;
    }
  });
}

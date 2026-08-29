import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

const activeKeys = new AsyncLocalStorage<ReadonlySet<string>>();
const queues = new Map<string, Promise<void>>();

/** Serialize tool-mediated mutations targeting the same workspace path. */
export async function withWorkspaceFileMutationQueue<T>(
  workspaceRoot: string,
  relativePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(workspaceRoot, relativePath);
  const active = activeKeys.getStore();
  if (active?.has(key)) return await operation();
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  queues.set(key, tail);

  await previous.catch(() => undefined);
  try {
    const nextActive = new Set(active);
    nextActive.add(key);
    return await activeKeys.run(nextActive, operation);
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

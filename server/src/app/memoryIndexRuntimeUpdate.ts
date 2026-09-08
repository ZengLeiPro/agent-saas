import type { AppConfig } from './config.js';
import type { MemoryIndexService } from '../memory/index/service.js';

export interface MemoryIndexRuntimeTransaction {
  commit(): void;
  rollback(): void;
  complete(): void;
  dispose(): void;
}

/** Preparation resolves credentials but neither swaps the running service nor retires it. */
export function createMemoryIndexRuntimeUpdatePreparer(options: {
  current: { current: MemoryIndexService | null };
  retained: Set<MemoryIndexService>;
  create: (config: NonNullable<AppConfig['memory']>['index']) => Promise<MemoryIndexService | null>;
  publish: (service: MemoryIndexService | null) => void;
  warn: (message: string) => void;
}): (config: NonNullable<AppConfig['memory']>['index']) => Promise<MemoryIndexRuntimeTransaction> {
  return async (config) => {
    const previous = options.current.current;
    const next = await options.create(config);
    const set = (service: MemoryIndexService | null) => {
      options.current.current = service;
      options.publish(service);
    };
    const retire = (service: MemoryIndexService | null) => {
      try {
        service?.retireAll();
      } catch {
        options.warn('Memory index watcher retirement failed; service retained until shutdown');
      }
    };
    return {
      commit: () => {
        if (next) options.retained.add(next);
        set(next);
      },
      rollback: () => set(previous),
      complete: () => {
        if (previous !== next) retire(previous);
      },
      dispose: () => {
        if (next && next !== options.current.current) {
          retire(next);
          // A prepared service has not created an indexer; a rolled-back one is
          // retained because in-flight operations may still own its snapshot.
          options.retained.add(next);
        }
      },
    };
  };
}

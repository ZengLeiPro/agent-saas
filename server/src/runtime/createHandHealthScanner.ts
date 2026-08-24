import type { RuntimeHandHealthScannerConfig } from '../app/config.js';
import { HandHealthScanner } from './handHealthScanner.js';
import type { HandRecord, HandStore } from './handStore.js';
import type { EventStore } from './types.js';

interface CreateHandHealthScannerOptions {
  config?: RuntimeHandHealthScannerConfig;
  handStore: HandStore;
  eventStore: EventStore;
  resolveHandAuthToken: (hand: HandRecord) => string | undefined | Promise<string | undefined>;
  defaultServerRemoteAuthToken?: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/** 生产默认给新会话绝对优先级：ACS 只要还有 Pending，就暂停历史 Hand 恢复。 */
export function createHandHealthScanner(options: CreateHandHealthScannerOptions): HandHealthScanner {
  return new HandHealthScanner({
    handStore: options.handStore,
    eventStore: options.eventStore,
    intervalMs: options.config?.intervalMs,
    healthTimeoutMs: options.config?.healthTimeoutMs,
    maxPendingSandboxesForReprovision: 0,
    resolveHandAuthToken: options.resolveHandAuthToken,
    defaultServerRemoteAuthToken: options.defaultServerRemoteAuthToken,
    logger: options.logger,
  });
}

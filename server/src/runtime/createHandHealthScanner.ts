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
  isExecutionEnabled?: () => boolean | Promise<boolean>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/** 只有 HandStore 选出的 active-run Hand 才会恢复；容量由 Orchestrator 权威门禁。 */
export function createHandHealthScanner(options: CreateHandHealthScannerOptions): HandHealthScanner {
  return new HandHealthScanner({
    handStore: options.handStore,
    eventStore: options.eventStore,
    intervalMs: options.config?.intervalMs,
    healthTimeoutMs: options.config?.healthTimeoutMs,
    resolveHandAuthToken: options.resolveHandAuthToken,
    defaultServerRemoteAuthToken: options.defaultServerRemoteAuthToken,
    isExecutionEnabled: options.isExecutionEnabled,
    logger: options.logger,
  });
}

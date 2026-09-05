import type { RuntimeHandHealthScannerConfig } from '../app/config.js';
import { createHandHealthScanner } from './createHandHealthScanner.js';
import type { HandHealthScanner } from './handHealthScanner.js';
import { HandLeaseJanitor } from './handLeaseJanitor.js';
import type { HandRecord, HandStore } from './handStore.js';
import type { EventStore } from './types.js';

export interface HandMaintenanceWorkers {
  handHealthScanner?: HandHealthScanner;
  handLeaseJanitor?: HandLeaseJanitor;
  stop: () => void;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Hand 维护类 singleton worker 的装配（仅 processRole=all/runtime-worker）。
 * - HandLeaseJanitor：租约老化。事故止血关闭 scanner 时 janitor 仍须运行，故不共用开关。
 * - HandHealthScanner（B4）：只恢复关联 active run 的 Server-remote Hand，历史会话由下一条真实消息按需复活。
 */
export function startHandMaintenanceWorkers(options: {
  enable: boolean;
  handStore: HandStore | undefined;
  eventStore: EventStore | undefined;
  scannerConfig: RuntimeHandHealthScannerConfig | undefined;
  resolveHandAuthToken: (hand: HandRecord) => string | undefined | Promise<string | undefined>;
  defaultServerRemoteAuthToken: string | undefined;
  isExecutionEnabled: () => boolean | Promise<boolean>;
  janitorLogger: Logger;
  scannerLogger: Logger;
}): HandMaintenanceWorkers {
  let handLeaseJanitor: HandLeaseJanitor | undefined;
  let handHealthScanner: HandHealthScanner | undefined;
  if (options.enable && options.handStore) {
    handLeaseJanitor = new HandLeaseJanitor({
      handStore: options.handStore,
      logger: options.janitorLogger,
    });
    handLeaseJanitor.start();
  }
  if (
    options.enable &&
    options.handStore &&
    options.eventStore &&
    options.scannerConfig?.enabled !== false
  ) {
    handHealthScanner = createHandHealthScanner({
      config: options.scannerConfig,
      handStore: options.handStore,
      eventStore: options.eventStore,
      resolveHandAuthToken: options.resolveHandAuthToken,
      defaultServerRemoteAuthToken: options.defaultServerRemoteAuthToken,
      logger: options.scannerLogger,
      isExecutionEnabled: options.isExecutionEnabled,
    });
    handHealthScanner.start();
  }
  return {
    handHealthScanner,
    handLeaseJanitor,
    stop: () => {
      handHealthScanner?.stop();
      handLeaseJanitor?.stop();
    },
  };
}

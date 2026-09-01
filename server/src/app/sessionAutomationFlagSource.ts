import type { AppConfig } from './config.js';
import {
  resolveSessionAutomationFlags,
  type SessionAutomationExecutionFlagSource,
} from '../runtime/sessionAutomationFlags.js';

export interface AttachableSessionAutomationFlagSource extends SessionAutomationExecutionFlagSource {
  attachRefresh(refreshIfChanged: () => void): void;
}

/** One mutable config-backed source shared by commands, runtime guards, and workers. */
export function createSessionAutomationFlagSource(
  config: Pick<AppConfig, 'sessionAutomation'>,
): AttachableSessionAutomationFlagSource {
  let refreshIfChanged = () => {};
  const source: AttachableSessionAutomationFlagSource = {
    attachRefresh: (refresh) => { refreshIfChanged = refresh; refreshIfChanged(); },
    read: () => {
      refreshIfChanged();
      return resolveSessionAutomationFlags(config.sessionAutomation);
    },
    executionEnabled: () => source.read().executionEnabled,
  };
  return source;
}

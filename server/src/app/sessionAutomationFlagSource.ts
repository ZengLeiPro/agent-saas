import type { AppConfig } from './config.js';
import {
  resolveSessionAutomationFlags,
  type SessionAutomationExecutionFlagSource,
} from '../runtime/sessionAutomationFlags.js';

type RefreshSharedConfig = () => boolean | Promise<boolean>;

export interface AttachableSessionAutomationFlagSource extends SessionAutomationExecutionFlagSource {
  attachRefresh(refreshIfChanged: RefreshSharedConfig): void;
}

/** One mutable config-backed source shared by commands, runtime guards, and workers. */
export function createSessionAutomationFlagSource(
  config: Pick<AppConfig, 'sessionAutomation'>,
): AttachableSessionAutomationFlagSource {
  let refreshIfChanged: RefreshSharedConfig = () => true;
  const refreshSynchronously = (): boolean => {
    try {
      const outcome = refreshIfChanged();
      if (outcome instanceof Promise) {
        void outcome.catch(() => undefined);
        return false;
      }
      return outcome;
    } catch {
      return false;
    }
  };
  const source: AttachableSessionAutomationFlagSource = {
    attachRefresh: (refresh) => {
      refreshIfChanged = refresh;
      refreshSynchronously();
    },
    read: () => {
      const fresh = refreshSynchronously();
      const flags = resolveSessionAutomationFlags(config.sessionAutomation);
      return fresh ? flags : { ...flags, executionEnabled: false };
    },
    executionEnabled: () => source.read().executionEnabled,
  };
  return source;
}

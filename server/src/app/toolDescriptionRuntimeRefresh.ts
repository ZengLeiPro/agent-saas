import type { AppConfig } from './config.js';
import {
  mergeToolDescriptionOverrides,
  type ToolDescriptionStore,
} from '../data/toolDescriptionStore.js';

/** Read on run admission, including approval resumes; never mutate release config. */
export function createToolDescriptionRuntimeRefresh(options: {
  store?: ToolDescriptionStore;
  refreshConfig: () => boolean | Promise<boolean>;
  config: AppConfig;
  target: { toolControls?: AppConfig['toolControls'] };
}): () => Promise<boolean> {
  return async () => {
    if (!(await options.refreshConfig())) return false;
    if (options.store) {
      try {
        const snapshot = await options.store.get();
        options.target.toolControls = mergeToolDescriptionOverrides(
          options.config.toolControls,
          snapshot.overrides,
        );
      } catch {
        // Do not start a run with unverified or cleared-but-stale prompt text.
        return false;
      }
    }
    return true;
  };
}

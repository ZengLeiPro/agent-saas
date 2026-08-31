import { selectSessionRuntime, type SessionRuntimeSelectorInput } from '@agent/shared';

/** Web is a presentation-only consumer of the shared runtime authority. */
export function adaptWebSessionRuntime(input: SessionRuntimeSelectorInput) {
  return selectSessionRuntime(input);
}

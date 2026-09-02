import { selectSessionRuntime, type SessionRuntimeSelectorInput } from '@agent/shared';

/** Mobile is a presentation-only consumer; AppState never mutates run authority. */
export function adaptMobileSessionRuntime(input: SessionRuntimeSelectorInput) {
  return selectSessionRuntime(input);
}

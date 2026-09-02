import {
  fenceAuthSideEffects,
  type AuthLifecycleTransaction,
  type AuthSessionBinding,
} from '@agent/shared';

export interface SavedAccountLifecycleEffects {
  fenceUntilCommit(): void | Promise<void>;
  persistTokenAndBinding(binding: AuthSessionBinding): void | Promise<void>;
  installAuthenticatedState(binding: AuthSessionBinding): void | Promise<void>;
  commitConnections(binding: AuthSessionBinding): void | Promise<void>;
  failClosed(): void | Promise<void>;
}

/** Web saved-account activation uses the same serialized identity boundary as login/logout. */
export function runSavedAccountLifecycle(
  lifecycle: AuthLifecycleTransaction,
  binding: AuthSessionBinding,
  effects: SavedAccountLifecycleEffects,
): Promise<unknown> {
  return lifecycle.login(binding, {
    ...effects,
    fenceUntilCommit: async () => {
      await fenceAuthSideEffects();
      await effects.fenceUntilCommit();
    },
  });
}

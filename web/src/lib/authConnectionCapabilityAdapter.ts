import {
  fetchAuthConnectionCapability,
  presentCapability,
  type AuthConnectionCapabilityStatus,
  type CapabilityAction,
} from '@agent/shared';

/** Thin web adapter. It never persists capability state and never opens a browser silently. */
export async function hydrateWebCapability(input: Parameters<typeof fetchAuthConnectionCapability>[0]) {
  const status = await fetchAuthConnectionCapability({ ...input, channel: 'web' });
  return { status, presentation: presentCapability(status) };
}

export async function runWebRecoveryAction(input: {
  action: CapabilityAction;
  status: AuthConnectionCapabilityStatus;
  confirmLeavingApp(): Promise<boolean>;
  openSystemBrowser(): void;
  revalidate(): Promise<AuthConnectionCapabilityStatus>;
}): Promise<AuthConnectionCapabilityStatus> {
  if (!input.status.allowedActions.includes(input.action)) throw new Error('Fallback action is not allowed');
  if (input.action === 'use_system_browser_sso') {
    if (!await input.confirmLeavingApp()) return input.status;
    input.openSystemBrowser();
    return input.status;
  }
  if (input.action === 'reauthenticate' || input.action === 'retry_later') return input.revalidate();
  return input.status;
}

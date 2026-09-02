import {
  fetchAuthConnectionCapability,
  presentCapability,
  reduceCapabilityStatus,
  type AuthConnectionCapabilityStatus,
  type CapabilityAction,
} from '@agent/shared';

/** Thin native adapter. Cold start always hydrates authority; cached degraded state is ignored. */
export async function hydrateMobileCapability(input: Parameters<typeof fetchAuthConnectionCapability>[0]) {
  const status = await fetchAuthConnectionCapability({ ...input, channel: 'mobile' });
  return { status, presentation: presentCapability(status) };
}

export function enterOfflineLocalShell(status: AuthConnectionCapabilityStatus, observedAt: string, correlationId: string) {
  return reduceCapabilityStatus(status, { type: 'client_offline', observedAt, correlationId });
}

export async function runMobileRecoveryAction(input: {
  action: CapabilityAction;
  status: AuthConnectionCapabilityStatus;
  confirmLeavingApp(): Promise<boolean>;
  openSystemBrowser(): Promise<void>;
  revalidate(): Promise<AuthConnectionCapabilityStatus>;
}): Promise<AuthConnectionCapabilityStatus> {
  if (!input.status.allowedActions.includes(input.action)) throw new Error('Fallback action is not allowed');
  if (input.action === 'use_system_browser_sso') {
    if (!await input.confirmLeavingApp()) return input.status;
    await input.openSystemBrowser();
    return input.status;
  }
  if (input.action === 'reauthenticate' || input.action === 'retry_later') return input.revalidate();
  return input.status;
}

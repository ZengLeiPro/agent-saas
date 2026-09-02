import * as LocalAuthentication from 'expo-local-authentication';

export type BiometricFailure = 'cancelled' | 'failed' | 'lockout';
export type BiometricPromptResult = { ok: true } | { ok: false; reason: BiometricFailure };
export interface BiometricAvailability { supported: boolean; enrolled: boolean }

interface NativeLocalAuthentication {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  supportedAuthenticationTypesAsync(): Promise<number[]>;
  authenticateAsync(options: {
    promptMessage: string;
    cancelLabel: string;
    fallbackLabel: string;
    disableDeviceFallback: boolean;
  }): Promise<{ success: boolean; error?: string }>;
}

export function createBiometricLocalAuth(native: NativeLocalAuthentication) {
  let inFlight: Promise<BiometricPromptResult> | null = null;
  return {
    async availability(): Promise<BiometricAvailability> {
      const [hardware, enrolled, types] = await Promise.all([
        native.hasHardwareAsync(),
        native.isEnrolledAsync(),
        native.supportedAuthenticationTypesAsync(),
      ]);
      return { supported: hardware && types.length > 0, enrolled };
    },
    authenticate(): Promise<BiometricPromptResult> {
      if (inFlight) return inFlight;
      inFlight = native.authenticateAsync({
        promptMessage: '解锁 Agent SaaS',
        cancelLabel: '取消',
        fallbackLabel: '使用设备密码',
        disableDeviceFallback: false,
      }).then((result) => {
        if (result.success) return { ok: true as const };
        if (result.error === 'lockout') return { ok: false as const, reason: 'lockout' as const };
        if (['user_cancel', 'system_cancel', 'app_cancel'].includes(result.error ?? '')) {
          return { ok: false as const, reason: 'cancelled' as const };
        }
        return { ok: false as const, reason: 'failed' as const };
      }).catch(() => ({ ok: false as const, reason: 'failed' as const })).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

export const biometricLocalAuth = createBiometricLocalAuth(LocalAuthentication);

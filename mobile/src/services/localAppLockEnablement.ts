import type { BiometricAvailability, BiometricPromptResult } from '../platform/biometricLocalAuth';

export type LocalLockSessionValidation = 'valid' | 'invalid' | 'offline';

interface EnablementDependencies {
  validateSession(): Promise<LocalLockSessionValidation>;
  availability(): Promise<BiometricAvailability>;
  authenticate(): Promise<BiometricPromptResult>;
  persist(): Promise<void>;
}

export async function enableLocalAppLock(
  dependencies: EnablementDependencies,
): Promise<{ ok: boolean; error?: string; availability?: BiometricAvailability }> {
  const validation = await dependencies.validateSession();
  if (validation !== 'valid') {
    return { ok: false, error: validation === 'offline' ? '需联网验证当前登录后才能开启' : '当前登录已失效，请重新登录' };
  }
  const availability = await dependencies.availability();
  if (!availability.supported) return { ok: false, error: '此设备不支持本地身份验证', availability };
  if (!availability.enrolled) return { ok: false, error: '请先在系统设置中录入生物识别或设备凭据', availability };
  const result = await dependencies.authenticate();
  if (!result.ok) {
    return {
      ok: false,
      error: result.reason === 'lockout'
        ? '生物识别已锁定，请使用设备密码或重新登录'
        : '未能完成本地身份验证',
      availability,
    };
  }
  await dependencies.persist();
  return { ok: true, availability };
}

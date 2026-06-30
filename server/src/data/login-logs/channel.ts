import type { LoginChannel } from './types.js';

/**
 * 从 User-Agent 推断登录渠道。
 *
 * React Native / Expo 的 UA 包含 Expo、okhttp（Android）、CFNetwork（iOS）等特征。
 */
export function detectLoginChannel(userAgent: string): LoginChannel {
  const ua = (userAgent || '').toLowerCase();
  if (
    ua.includes('expo') ||
    ua.includes('okhttp') ||
    ua.includes('cfnetwork') ||
    ua.includes('react-native')
  ) {
    return 'mobile';
  }
  return 'web';
}

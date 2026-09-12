import type { AppConfig } from '../app/config.js';
import { orderedCredentialRefs } from '../runtime/responses/subscriptionAccountBinding.js';
export class ConfigPublicationLockUnavailableError extends Error {
  readonly code = 'CONFIG_PUBLICATION_LOCK_BUSY';

  constructor(cause: unknown) {
    super('生产配置正在发布或凭据刷新，请稍后重试', { cause });
    this.name = 'ConfigPublicationLockUnavailableError';
  }
}
export function configuredSubscriptionProvider(
  config: AppConfig,
  ref: string,
): { id: 'codex' | 'grok'; root: 'codexSubscription' | 'grokSubscription' } {
  const codex = orderedCredentialRefs(config.codexSubscription).includes(ref);
  const grok = orderedCredentialRefs(config.grokSubscription).includes(ref);
  if (codex === grok) throw new Error('拒绝为未登记或提供方不唯一的订阅凭据推进签名身份');
  return grok
    ? { id: 'grok', root: 'grokSubscription' }
    : { id: 'codex', root: 'codexSubscription' };
}
export function isCredentialRotationPublication(paths: readonly string[]): boolean {
  return (
    paths.length === 1 &&
    [
      'runtime-credential-rotation:codexSubscription',
      'runtime-credential-rotation:grokSubscription',
    ].includes(paths[0])
  );
}

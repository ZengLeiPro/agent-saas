import type { AppConfig } from './config.js';
import type { SttRuntimeUpdateCommit } from './sttRuntimeUpdate.js';
import type { SecretVault } from '../security/secretVault.js';

/** 串行刷新 Voice 凭据，并在提交前确认源配置仍是当前版本。 */
export function createVoiceTranscriptionConfigRefresher(params: {
  config: AppConfig;
  secretVault: SecretVault;
  refreshSharedConfig: () => boolean | Promise<boolean>;
  prepareSttUpdate: (next: AppConfig['stt']) => Promise<SttRuntimeUpdateCommit>;
}): () => Promise<boolean> {
  let pending = Promise.resolve();
  const refresh = async (): Promise<boolean> => {
    if (!await params.refreshSharedConfig()) return false;
    const stt = params.config.stt;
    const refs = new Set([
      stt?.apiKeyRef,
      stt?.ossAccessKeyIdRef,
      stt?.ossAccessKeySecretRef,
    ].filter((ref): ref is string => Boolean(ref)));
    for (const ref of refs) params.secretVault.invalidate?.(ref);
    const commit = await params.prepareSttUpdate(stt);
    if (params.config.stt !== stt) throw new Error('STT 配置刷新已被更新版本取代');
    commit();
    return true;
  };
  return () => {
    const current = pending.then(refresh, refresh);
    pending = current.then(() => undefined, () => undefined);
    return current;
  };
}

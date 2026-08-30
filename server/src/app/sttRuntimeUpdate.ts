import type { AppConfig } from './config.js';
import type { ResolvedAudioTranscribeConfig } from '../agent/audioTranscribeToolProvider.js';
import type { SttConfig } from '../integrations/stt/sttClient.js';
import type { SecretVault } from '../security/secretVault.js';
import { resolveSttRuntimeConfig } from '../runtime/sttRuntimeConfig.js';

export type SttRuntimeUpdateCommit = () => void;

export interface SttRuntimeUpdateTarget {
  audioTranscribeTools?: ResolvedAudioTranscribeConfig;
}

export interface WebChannelSttRuntimeTarget {
  sttConfig?: SttConfig;
}

/**
 * STT 热更新的 prepare 阶段：先完成所有 SecretVault 解析，不修改执行侧状态。
 * 返回的 commit 只做同步赋值，可与 AppConfig、observed identity 在最终发布点提交。
 */
export function createSttRuntimeUpdatePreparer(params: {
  target: SttRuntimeUpdateTarget;
  webChannelTarget?: WebChannelSttRuntimeTarget;
  secretVault: SecretVault;
}): (next: AppConfig['stt']) => Promise<SttRuntimeUpdateCommit> {
  return async (next) => {
    const resolved = await resolveSttRuntimeConfig(next, params.secretVault);
    return () => {
      if (resolved.audioTranscribeConfig) {
        params.target.audioTranscribeTools = resolved.audioTranscribeConfig;
      } else {
        delete params.target.audioTranscribeTools;
      }
      if (params.webChannelTarget) {
        if (resolved.sttConfig) params.webChannelTarget.sttConfig = resolved.sttConfig;
        else delete params.webChannelTarget.sttConfig;
      }
    };
  };
}

import {
  AudioTranscribeToolProvider,
  type AudioTranscribeToolProviderOptions,
  type ResolvedAudioTranscribeToolsConfig,
} from '../agent/audioTranscribeToolProvider.js';
import { isToolEnabled, type ToolProvider } from '../agent/toolRuntime.js';
import type { ToolControlsConfig } from '../app/config.js';
import type { SkillEntry } from '../agent/skillToolProvider.js';

export interface AudioTranscribeRuntimeConfig
  extends Omit<AudioTranscribeToolProviderOptions, 'config'> {
  audioTranscribeTools?: ResolvedAudioTranscribeToolsConfig;
  toolControls?: ToolControlsConfig;
}

export function createAudioTranscribeRuntimeProvider(
  config: AudioTranscribeRuntimeConfig,
): ToolProvider | undefined {
  if (!config.audioTranscribeTools?.enabled || !isToolEnabled(config.toolControls, 'AudioTranscribe')) return undefined;
  return new AudioTranscribeToolProvider({
    config: config.audioTranscribeTools,
    billingService: config.billingService,
    appendPlatformEvent: config.appendPlatformEvent,
    logger: config.logger,
  });
}

/** `audio-transcribe` skill 只在直连工具可用时显示。 */
export function buildAudioTranscribeSkillFilter(
  config: Pick<AudioTranscribeRuntimeConfig, 'audioTranscribeTools' | 'toolControls'>,
): (skill: SkillEntry) => boolean {
  const available = config.audioTranscribeTools?.enabled === true
    && isToolEnabled(config.toolControls, 'AudioTranscribe');
  if (available) return () => true;
  return (skill) => skill.id !== 'audio-transcribe' && skill.name !== 'audio-transcribe';
}

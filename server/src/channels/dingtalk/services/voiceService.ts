import { sendVoiceMessage } from '../../../integrations/dingtalk/voiceApi.js';
import { dingtalkLogger } from '../../../utils/logger.js';
import type { DingtalkRobotConfig, TtsConfig } from '../../../types/index.js';
import type { DingtalkMessageContext } from '../types.js';
import type { DingtalkCredentials } from '../../../integrations/dingtalk/mediaApi.js';
import { parseVoiceMarkers } from '../../../utils/voiceMarkers.js';
import type { VoiceMarker, ParsedVoiceMarkers } from '../../../utils/voiceMarkers.js';

export type { VoiceMarker, ParsedVoiceMarkers };

export interface DispatchVoiceMarkersInput {
  markers: VoiceMarker[];
  sessionWebhook: string;
  ttsConfig?: TtsConfig;
  credentials?: DingtalkCredentials;
}

export { parseVoiceMarkers };

export async function dispatchVoiceMarkers(input: DispatchVoiceMarkersInput): Promise<void> {
  const { markers, sessionWebhook, ttsConfig, credentials } = input;
  for (const marker of markers) {
    try {
      const result = await sendVoiceMessage({
        text: marker.text,
        sessionWebhook,
        voice: marker.voice,
        speed: marker.speed,
        ttsConfig,
        credentials,
      });
      if (result.success) {
        dingtalkLogger.info('[VOICE] TTS 语音已发送');
      } else {
        dingtalkLogger.error(`[VOICE] 语音发送失败: ${result.error}`);
      }
    } catch (err: any) {
      dingtalkLogger.error(`[VOICE] 语音发送失败: ${err.message}`);
    }
  }
}

export interface VoiceMarkerProcessInput {
  content: string;
  context: Pick<DingtalkMessageContext, 'sessionWebhook'>;
  robotConfig?: Pick<DingtalkRobotConfig, 'appKey' | 'appSecret'>;
}

export interface DingtalkVoiceServiceConfig {
  tts?: TtsConfig;
}

export class DingtalkVoiceService {
  constructor(private readonly config: DingtalkVoiceServiceConfig) {}

  async processVoiceMarkers(input: VoiceMarkerProcessInput): Promise<string> {
    const { content, context, robotConfig } = input;
    const credentials = robotConfig?.appKey && robotConfig?.appSecret
      ? { appKey: robotConfig.appKey, appSecret: robotConfig.appSecret }
      : undefined;
    const parsed = parseVoiceMarkers(content);
    if (parsed.markers.length === 0) {
      return parsed.cleanedText;
    }

    await dispatchVoiceMarkers({
      markers: parsed.markers,
      sessionWebhook: context.sessionWebhook,
      ttsConfig: this.config.tts,
      credentials,
    });
    return parsed.cleanedText;
  }
}

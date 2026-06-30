/**
 * Voice Markers 解析
 *
 * 解析 [VOICE voice=xxx speed=1.2]文本[/VOICE] 标记。
 * 共享模块，供 Web Channel 和 DingTalk Channel 复用。
 */

const VOICE_MARKER_PATTERN = /\[VOICE(?:\s+([^\]]*))?\]([\s\S]*?)\[\/VOICE\]/g;

export interface VoiceMarker {
  text: string;
  voice?: string;
  speed?: number;
}

export interface ParsedVoiceMarkers {
  cleanedText: string;
  markers: VoiceMarker[];
}

export function parseVoiceMarkers(content: string): ParsedVoiceMarkers {
  const text = String(content || '');
  const markers: VoiceMarker[] = [];

  const matches = [...text.matchAll(VOICE_MARKER_PATTERN)];
  for (const match of matches) {
    const params = match[1] || '';
    const voiceText = match[2]?.trim();
    if (!voiceText) {
      continue;
    }

    const voiceParam = params.match(/voice=(\w+)/)?.[1];
    const speedParam = params.match(/speed=([\d.]+)/)?.[1];
    markers.push({
      text: voiceText,
      voice: voiceParam,
      speed: speedParam ? parseFloat(speedParam) : undefined,
    });
  }

  return {
    cleanedText: text.replace(VOICE_MARKER_PATTERN, '').trim(),
    markers,
  };
}

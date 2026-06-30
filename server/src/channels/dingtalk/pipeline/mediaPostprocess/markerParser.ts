import {
  AUDIO_MARKER_PATTERN,
  FILE_MARKER_PATTERN,
  VIDEO_MARKER_PATTERN,
} from '../../../../integrations/dingtalk/constants.js';

export interface MarkerMatch {
  fullMatch: string;
  payload: string;
  index: number;
}

function parseMarkerMatches(content: string, pattern: RegExp): MarkerMatch[] {
  const matches: MarkerMatch[] = [];
  for (const match of content.matchAll(pattern)) {
    matches.push({
      fullMatch: match[0],
      payload: match[1] || '',
      index: match.index ?? -1,
    });
  }
  return matches;
}

export function parseVideoMarkerMatches(content: string): MarkerMatch[] {
  return parseMarkerMatches(content, VIDEO_MARKER_PATTERN);
}

export function parseAudioMarkerMatches(content: string): MarkerMatch[] {
  return parseMarkerMatches(content, AUDIO_MARKER_PATTERN);
}

export function parseFileMarkerMatches(content: string): MarkerMatch[] {
  return parseMarkerMatches(content, FILE_MARKER_PATTERN);
}

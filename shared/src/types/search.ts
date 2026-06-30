import type { SessionOwnerInfo } from './session';

export type SessionSearchMatchKind = 'title' | 'preview' | 'message' | 'tool' | 'meta';

export interface SessionSearchMatchRange {
  start: number;
  end: number;
}

export interface SessionSearchMatch {
  kind: SessionSearchMatchKind;
  blockId?: string;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  snippet: string;
  ranges?: SessionSearchMatchRange[];
  tsMs?: number;
}

export interface SessionSearchHit {
  sessionId: string;
  title?: string;
  preview?: string;
  source?: { type: 'web' | 'dingtalk' | 'cron'; label: string };
  owner?: SessionOwnerInfo;
  updatedAtMs: number;
  createdAtMs?: number;
  score: number;
  matches: SessionSearchMatch[];
}

export interface SessionSearchResponse {
  hits: SessionSearchHit[];
  hasMore: boolean;
  nextCursor?: string;
}

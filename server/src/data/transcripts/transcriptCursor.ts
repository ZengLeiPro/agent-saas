import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';

const TRANSCRIPT_WINDOW_CURSOR_PREFIX = 'tw2.';
const LEGACY_TRANSCRIPT_WINDOW_CURSOR_PREFIX = 'tw1.';
const transcriptWindowProcessSeed = createHash('sha256')
  .update(`${process.pid}:${Date.now()}:${Math.random()}`)
  .digest('base64url')
  .slice(0, 12);
let transcriptWindowGenerationSequence = 0;

export function createTranscriptWindowGeneration(stat: Stats): string {
  transcriptWindowGenerationSequence += 1;
  return `${transcriptWindowProcessSeed}:${stat.dev}:${stat.ino}:${transcriptWindowGenerationSequence}`;
}

export function encodeTranscriptWindowCursor(generation: string, blockId?: string): string | undefined {
  if (!blockId) return undefined;
  const match = /^line-(\d+)(?:-.*?-(\d+))?(?:-|$)/.exec(blockId);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  const eventIndex = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(eventIndex)) return undefined;
  return `${TRANSCRIPT_WINDOW_CURSOR_PREFIX}${Buffer.from(JSON.stringify({
    version: 2,
    revision: generation,
    sequence,
    eventIndex,
    stableId: blockId,
  })).toString('base64url')}`;
}

export function resolveTranscriptWindowCursor(
  cursor: string | undefined,
  generation: string,
): { blockId?: string; invalidated: boolean } {
  if (!cursor) return { invalidated: false };
  if (!cursor.startsWith(TRANSCRIPT_WINDOW_CURSOR_PREFIX)
    && !cursor.startsWith(LEGACY_TRANSCRIPT_WINDOW_CURSOR_PREFIX)) {
    return /^line-\d+(?:-|$)/.test(cursor)
      ? { blockId: cursor, invalidated: false }
      : { invalidated: true };
  }
  if (cursor.length > 2_048) return { invalidated: true };
  try {
    if (cursor.startsWith(LEGACY_TRANSCRIPT_WINDOW_CURSOR_PREFIX)) {
      const decoded = JSON.parse(Buffer.from(
        cursor.slice(LEGACY_TRANSCRIPT_WINDOW_CURSOR_PREFIX.length),
        'base64url',
      ).toString('utf8')) as { generation?: unknown; blockId?: unknown };
      return decoded.generation === generation
        && typeof decoded.blockId === 'string'
        && /^line-\d+(?:-|$)/.test(decoded.blockId)
        ? { blockId: decoded.blockId, invalidated: false }
        : { invalidated: true };
    }
    const decoded = JSON.parse(Buffer.from(
      cursor.slice(TRANSCRIPT_WINDOW_CURSOR_PREFIX.length),
      'base64url',
    ).toString('utf8')) as {
      version?: unknown; revision?: unknown; sequence?: unknown; eventIndex?: unknown; stableId?: unknown;
    };
    if (decoded.version !== 2 || decoded.revision !== generation
      || typeof decoded.sequence !== 'number' || !Number.isSafeInteger(decoded.sequence)
      || typeof decoded.eventIndex !== 'number' || !Number.isSafeInteger(decoded.eventIndex)
      || typeof decoded.stableId !== 'string') return { invalidated: true };
    const stableMatch = /^line-(\d+)(?:-.*?-(\d+))?(?:-|$)/.exec(decoded.stableId);
    const stableSequence = stableMatch ? Number(stableMatch[1]) : Number.NaN;
    const stableIndex = stableMatch?.[2] === undefined ? 0 : Number(stableMatch[2]);
    if (stableSequence !== decoded.sequence || stableIndex !== decoded.eventIndex) return { invalidated: true };
    return { blockId: decoded.stableId, invalidated: false };
  } catch {
    return { invalidated: true };
  }
}

import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeSessionMeta } from '../data/transcripts/meta.js';
import { parseTranscriptFile, readTranscriptLinesBounded } from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { UnsafeFilePathError } from '../security/trustedFile.js';

const SESSION_ID = '19819819-8198-4198-8198-198198198198';
const cleanup = new Set<string>();

function line(content: string): string {
  return JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { content } });
}

describe('trusted transcript descriptor boundaries', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
    rootDir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'trusted-boundary-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'trusted-transcript-outside-'));
    cleanup.add(rootDir);
    cleanup.add(outsideDir);
  });

  afterEach(async () => {
    await Promise.all([...cleanup].map((dir) => rm(dir, { recursive: true, force: true })));
    cleanup.clear();
  });

  it('rejects ancestor symlinks for transcript parsing and meta writes', async () => {
    await writeFile(join(outsideDir, `${SESSION_ID}.jsonl`), `${line('outside secret')}\n`);
    await symlink(outsideDir, join(rootDir, 'linked'));
    const transcriptPath = join(rootDir, 'linked', `${SESSION_ID}.jsonl`);

    await expect(parseTranscriptFile(transcriptPath)).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(writeSessionMeta(transcriptPath, {
      userId: 'u', username: 'u', channel: 'web', createdAt: new Date(0).toISOString(),
    })).rejects.toBeInstanceOf(UnsafeFilePathError);
  });

  it('keeps an open transcript inode pinned after ancestor rename to symlink', async () => {
    const activeDir = join(rootDir, 'active');
    await mkdir(activeDir);
    const transcriptPath = join(activeDir, `${SESSION_ID}.jsonl`);
    const expectedLines = Array.from({ length: 5_000 }, (_, index) => line(`inside-${index + 1}`));
    await writeFile(transcriptPath, `${expectedLines.join('\n')}\n`);
    await writeFile(join(outsideDir, `${SESSION_ID}.jsonl`), `${line('outside secret')}\n`);

    const iterator = readTranscriptLinesBounded(transcriptPath);
    const first = await iterator.next();
    expect(first.value).toMatchObject({ oversized: false, line: expectedLines[0] });

    await rename(activeDir, join(rootDir, 'pinned-original'));
    await symlink(outsideDir, activeDir);

    const remaining: string[] = [];
    for await (const record of iterator) {
      if (!record.oversized) remaining.push(record.line);
    }
    expect(remaining).toHaveLength(expectedLines.length - 1);
    expect(remaining.at(-1)).toBe(expectedLines.at(-1));
    expect(remaining.join('\n')).not.toContain('outside secret');
    await expect(parseTranscriptFile(transcriptPath)).rejects.toBeInstanceOf(UnsafeFilePathError);
  });

  it('rejects transcript parsing and writes outside the transcript root', async () => {
    const outsidePath = join(outsideDir, `${SESSION_ID}.jsonl`);
    await writeFile(outsidePath, `${line('outside secret')}\n`);

    await expect(parseTranscriptFile(outsidePath)).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(writeSessionMeta(outsidePath, {
      userId: 'u', username: 'u', channel: 'web', createdAt: new Date(0).toISOString(),
    })).rejects.toBeInstanceOf(UnsafeFilePathError);
  });
});

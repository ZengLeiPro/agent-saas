import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractRecentUserMessages } from '../agent/guardrail.js';
import { extractTitleContext } from '../agent/titleGenerator.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { openTrustedTranscript } from '../data/transcripts/trusted.js';
import { relativeToTrustedRoot, UnsafeFilePathError } from '../security/trustedFile.js';
import { FileApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { scanRuntimeSessionMetaFiles } from '../runtime/sessionProjectionStore.js';

const TENANT_ID = 'tenant-runtime-fd';
const SESSION_ID = '19819819-8198-4198-8198-198198198198';
const cleanup = new Set<string>();

function userLine(content: string): string {
  return JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { content } });
}

function assistantLine(content: string): string {
  return JSON.stringify({ type: 'assistant', sessionId: SESSION_ID, message: { content } });
}

describe('runtime transcript FD boundaries', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
    rootDir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'runtime-fd-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'runtime-fd-outside-'));
    cleanup.add(rootDir);
    cleanup.add(outsideDir);
  });

  afterEach(async () => {
    await Promise.all([...cleanup].map((dir) => rm(dir, { recursive: true, force: true })));
    cleanup.clear();
  });

  it('rejects ancestor symlinks for legacy/runtime-event/approval appends and reads', async () => {
    await symlink(outsideDir, join(rootDir, 'linked'));
    const transcriptPath = join(rootDir, 'linked', `${SESSION_ID}.jsonl`);
    const eventPath = join(rootDir, 'linked', `${SESSION_ID}.runtime-events.jsonl`);
    const approvalPath = join(rootDir, 'linked', `${SESSION_ID}.approvals.jsonl`);

    await expect(new LegacyTranscriptProjection(transcriptPath).project({
      id: 'event-1', type: 'user_message', sessionId: SESSION_ID, runId: 'run-1',
      timestamp: new Date(0).toISOString(), content: 'inside only',
    } as any)).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(new FileEventStore(eventPath, TENANT_ID).append({
      type: 'user_message', sessionId: SESSION_ID, runId: 'run-1', content: 'inside only',
    }, { tenantId: TENANT_ID })).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(new FileApprovalStore(approvalPath).create({
      sessionId: SESSION_ID, runId: 'run-1', toolCallId: 'tool-1', toolId: 'Shell',
      toolName: 'Shell', displayName: 'Shell', input: {},
    })).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(new FileEventStore(eventPath, TENANT_ID).list(TENANT_ID, SESSION_ID)).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(extractTitleContext(transcriptPath)).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(extractRecentUserMessages(transcriptPath)).resolves.toEqual([]);

    await expect(readFile(join(outsideDir, `${SESSION_ID}.jsonl`), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects the production root boundary while preserving explicit test roots and /dev/null projection', () => {
    const eventPath = join(outsideDir, `${SESSION_ID}.runtime-events.jsonl`);
    const approvalPath = join(outsideDir, `${SESSION_ID}.approvals.jsonl`);
    const transcriptPath = join(outsideDir, `${SESSION_ID}.jsonl`);

    expect(() => relativeToTrustedRoot(AGENT_LEGACY_TRANSCRIPTS_ROOT, eventPath))
      .toThrow(UnsafeFilePathError);
    expect(() => new FileEventStore(eventPath, TENANT_ID, outsideDir)).not.toThrow();
    expect(() => new FileApprovalStore(approvalPath, outsideDir)).not.toThrow();
    expect(() => new LegacyTranscriptProjection(transcriptPath, outsideDir)).not.toThrow();
    expect(() => new LegacyTranscriptProjection('/dev/null')).not.toThrow();
  });

  it('keeps title and guardrail reads pinned when an ancestor is swapped to a symlink', async () => {
    const activeDir = join(rootDir, 'active');
    await mkdir(activeDir);
    const transcriptPath = join(activeDir, `${SESSION_ID}.jsonl`);
    await writeFile(transcriptPath, `${userLine('inside question')}\n${assistantLine('inside answer')}\n`);
    await writeFile(
      join(outsideDir, `${SESSION_ID}.jsonl`),
      `${userLine('outside secret')}\n${assistantLine('outside answer')}\n`,
    );

    const trusted = await openTrustedTranscript(transcriptPath);
    try {
      await rename(activeDir, join(rootDir, 'pinned-original'));
      await symlink(outsideDir, activeDir);

      await expect(extractTitleContext(trusted.handle)).resolves.toEqual({
        userMessages: ['inside question'], assistantReplies: ['inside answer'],
      });
      await expect(extractRecentUserMessages(trusted.handle, 1)).resolves.toEqual(['inside question']);
    } finally {
      await trusted.handle.close();
    }
    await expect(extractTitleContext(transcriptPath)).rejects.toBeInstanceOf(UnsafeFilePathError);
  });

  it('does not traverse symlinked ancestors while scanning session projection metadata', async () => {
    const outsideMeta = join(outsideDir, `${SESSION_ID}.meta.json`);
    await writeFile(outsideMeta, JSON.stringify({
      userId: 'outside-user', username: 'outside', channel: 'web', createdAt: new Date(0).toISOString(),
    }));
    await symlink(outsideDir, join(rootDir, 'linked-tenant'));

    const scan = await scanRuntimeSessionMetaFiles(rootDir);
    expect(scan.files).toEqual([]);
    expect(scan.scannedMetaFiles).toBe(0);
  });
});

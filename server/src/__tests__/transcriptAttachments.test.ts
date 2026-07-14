import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTranscriptFile } from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import type { ModelAttachmentRef, PlatformEvent } from '../runtime/types.js';

/**
 * 用户消息附件的持久化闭环：
 * user_message event（带 attachments）→ legacy transcript user 行（顶层 attachments 字段）
 * → parseTranscriptFile → prompt block.attachments → 前端刷新后仍能展示附件。
 *
 * 背景：2026-07-14 之前投影层丢弃 event.attachments，刷新后附件消失
 * （实时 WS 路径带结构化 meta 所以发送时可见）。
 */

function attachment(overrides: Partial<ModelAttachmentRef> = {}): ModelAttachmentRef {
  return {
    attachmentId: 'att-1',
    originalName: '报价单.pdf',
    relativePath: 'uploads/att-1/报价单.pdf',
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    isImage: false,
    ...overrides,
  };
}

function userMessageEvent(overrides: Record<string, unknown> = {}): PlatformEvent {
  return {
    id: 'event-1',
    timestamp: new Date(2026, 6, 14, 12, 0, 0).toISOString(),
    type: 'user_message',
    runId: 'run-1',
    sessionId: 'session-1',
    content: '看下这份报价',
    ...overrides,
  } as PlatformEvent;
}

describe('transcript attachments round-trip', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    // parseTranscriptFile 强制 allowed-root 断言，临时目录放在真实 transcript 根下
    await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
    dir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'transcript-att-test-'));
    transcriptPath = join(dir, 'session-1.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('projects user_message attachments onto the transcript user line', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(userMessageEvent({
      attachments: [
        attachment(),
        attachment({ attachmentId: 'att-2', originalName: 'photo.png', mimeType: 'image/png', isImage: true }),
      ],
    }));

    const line = JSON.parse((await readFile(transcriptPath, 'utf-8')).trim());
    expect(line.type).toBe('user');
    expect(line.message.content).toBe('看下这份报价');
    expect(line.attachments).toEqual([
      { name: '报价单.pdf', isImage: false },
      { name: 'photo.png', isImage: true },
    ]);
  });

  it('omits the attachments field when the event has none', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(userMessageEvent());

    const line = JSON.parse((await readFile(transcriptPath, 'utf-8')).trim());
    expect(line).not.toHaveProperty('attachments');
  });

  it('parses transcript attachments back onto the prompt block', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(userMessageEvent({
      attachments: [attachment({ originalName: 'photo.png', mimeType: 'image/png', isImage: true })],
    }));

    const parsed = await parseTranscriptFile(transcriptPath);
    const prompt = parsed.blocks.find((block) => block.kind === 'prompt');
    expect(prompt).toBeDefined();
    expect(prompt?.content).toBe('看下这份报价');
    expect(prompt?.attachments).toEqual([{ name: 'photo.png', isImage: true }]);
  });

  it('keeps prompt blocks without attachments unchanged', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(userMessageEvent());

    const parsed = await parseTranscriptFile(transcriptPath);
    const prompt = parsed.blocks.find((block) => block.kind === 'prompt');
    expect(prompt).toBeDefined();
    expect(prompt).not.toHaveProperty('attachments');
  });

  it('ignores malformed attachment entries when parsing', async () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      attachments: [{ isImage: true }, { name: 42 }, 'junk', { name: 'ok.txt' }],
      sessionId: 'session-1',
      timestamp: new Date(2026, 6, 14, 12, 0, 0).toISOString(),
    }) + '\n';
    const { writeFile } = await import('fs/promises');
    await writeFile(transcriptPath, line, 'utf-8');

    const parsed = await parseTranscriptFile(transcriptPath);
    const prompt = parsed.blocks.find((block) => block.kind === 'prompt');
    expect(prompt?.attachments).toEqual([{ name: 'ok.txt' }]);
  });
});

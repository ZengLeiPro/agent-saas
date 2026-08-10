import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildChatMessageActivityDetail } from '../channels/web/channel.js';
import { appendLoginLog, queryLoginLogs, redactLegacyChatPreviewsInFile } from '../data/login-logs/store.js';

describe('聊天活动日志脱敏', () => {
  it('仅记录会话与附件元数据，不接受或生成消息正文预览', () => {
    const detail = buildChatMessageActivityDetail('session-1', 2, 1500);

    expect(detail).toBe('session=session-1 | attachments=2 | voice=1500ms');
    expect(detail).not.toContain('preview=');
  });

  it('启动回填会物理移除旧 preview，同时原样保留损坏行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-log-physical-redaction-'));
    const filePath = join(dir, 'login.jsonl');
    try {
      writeFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-08-08T00:00:00.000Z',
          event: 'chat_message_sent',
          username: 'alice',
          ip: '127.0.0.1',
          userAgent: 'test',
          channel: 'web',
          detail: 'session=s1 | attachments=0 | preview=机密正文',
        }),
        '{broken-json',
        '',
      ].join('\n'));

      await expect(redactLegacyChatPreviewsInFile(filePath)).resolves.toEqual({ redacted: 1 });
      const raw = readFileSync(filePath, 'utf-8');
      expect(raw).not.toContain('机密正文');
      expect(raw).toContain('{broken-json');
      await expect(redactLegacyChatPreviewsInFile(filePath)).resolves.toEqual({ redacted: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('查询历史日志时兼容移除旧 preview 字段', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-log-redaction-'));
    const filePath = join(dir, 'login.jsonl');
    try {
      await appendLoginLog({
        timestamp: '2026-08-08T00:00:00.000Z',
        event: 'chat_message_sent',
        username: 'alice',
        ip: '127.0.0.1',
        userAgent: 'test',
        channel: 'web',
        detail: 'session=s1 | attachments=0 | preview=机密正文 | 仍是正文',
      }, filePath);

      const result = await queryLoginLogs({}, filePath);
      expect(result.entries[0].detail).toBe('session=s1 | attachments=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

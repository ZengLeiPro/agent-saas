import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AdminConfigOperationConflictError,
  AdminConfigOperationJournal,
} from './adminConfigOperationJournal.js';

describe('AdminConfigOperationJournal', () => {
  it('用受保护摘要绑定操作者、操作与请求语义，且不落明文 secret', () => {
    const root = mkdtempSync(join(tmpdir(), 'config-operation-journal-'));
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}');
    const authority = join(root, 'config-publications');
    mkdirSync(join(authority, 'operations'), { recursive: true, mode: 0o700 });
    writeFileSync(join(authority, 'private.pem'), 'private-test-key', { mode: 0o600 });
    const journal = new AdminConfigOperationJournal(configPath);
    const record = journal.begin({
      operationId: 'operation-12345678',
      operation: 'stt.save',
      actor: 'admin',
      semantic: { apiKey: 'low-entropy-secret' },
      beforeRevision: 'a'.repeat(64),
      now: '2026-09-10T00:00:00.000Z',
    });
    expect(JSON.stringify(record)).not.toContain('low-entropy-secret');
    expect(
      journal.begin({
        operationId: 'operation-12345678',
        operation: 'stt.save',
        actor: 'admin',
        semantic: { apiKey: 'low-entropy-secret' },
        beforeRevision: 'a'.repeat(64),
        now: record.updatedAt,
      }),
    ).toEqual(record);
    expect(() =>
      journal.begin({
        operationId: 'operation-12345678',
        operation: 'stt.save',
        actor: 'admin',
        semantic: { apiKey: 'different' },
        beforeRevision: 'a'.repeat(64),
        now: record.updatedAt,
      }),
    ).toThrow(AdminConfigOperationConflictError);
    const publishing = journal.update(record, {
      state: 'publishing',
      publicationRevision: 'publication-12345678',
    });
    expect(journal.findByPublicationRevision('publication-12345678')).toEqual(publishing);
  });
});

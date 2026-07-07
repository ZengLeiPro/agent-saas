import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { csvField, RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';

const unzip = promisify(gunzip);

type ArchiveRow = {
  global_sequence: string;
  event_id: string;
  session_id: string;
  session_sequence: string;
  run_id: string | null;
  tenant_id: string;
  event_type: string;
  timestamp: string;
  event_json: unknown;
};

class FakePool {
  billingWatermark = '0';
  maxGlobalSequence = '0';
  toolBatches: ArchiveRow[][] = [];
  handBatches: ArchiveRow[][] = [];
  deletedSequences: string[] = [];
  vacuumed = false;
  queries: string[] = [];

  async query(text: string, params?: unknown[]) {
    this.queries.push(text);
    if (text.includes('FROM runtime_billing_projection_state')) {
      return { rows: [{ last_global_sequence: this.billingWatermark }] };
    }
    if (text.includes('MAX(global_sequence)')) {
      return { rows: [{ max_global_sequence: this.maxGlobalSequence }] };
    }
    if (text.includes('completed.event_type')) {
      return { rows: this.toolBatches.shift() ?? [] };
    }
    if (text.includes('event_type = ANY($1::text[])')) {
      return { rows: this.handBatches.shift() ?? [] };
    }
    if (text.includes('DELETE FROM runtime_events')) {
      const sequences = params?.[0] as string[];
      this.deletedSequences.push(...sequences);
      return { rows: [], rowCount: sequences.length };
    }
    if (text.includes('VACUUM (ANALYZE) runtime_events')) {
      this.vacuumed = true;
      return { rows: [] };
    }
    return { rows: [] };
  }
}

describe('RuntimeEventRetention', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('escapes CSV fields', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,"b"\n')).toBe('"a,""b""\n"');
  });

  it('refuses to delete when billing projection is behind runtime_events', async () => {
    const archiveDir = await mkdtemp(join(tmpdir(), 'runtime-retention-behind-'));
    cleanupDirs.add(archiveDir);
    const pool = new FakePool();
    pool.billingWatermark = '10';
    pool.maxGlobalSequence = '11';
    pool.toolBatches = [[row('11', 'tool_output_delta')]];
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      archiveDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    await expect(retention.runOnce()).rejects.toThrow('billing projection is behind runtime_events');

    expect(pool.deletedSequences).toEqual([]);
    expect(pool.vacuumed).toBe(false);
  });

  it('archives selected rows to csv.gz before deleting and then vacuums', async () => {
    const archiveDir = await mkdtemp(join(tmpdir(), 'runtime-retention-ok-'));
    cleanupDirs.add(archiveDir);
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    pool.toolBatches = [[row('10', 'tool_output_delta'), row('11', 'tool_progress')], []];
    pool.handBatches = [[row('12', 'hand_failure')], []];
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      archiveDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    const result = await retention.runOnce();

    expect(result.archived).toBe(3);
    expect(result.deleted).toBe(3);
    expect(result.archiveFiles).toHaveLength(2);
    expect(pool.deletedSequences).toEqual(['10', '11', '12']);
    expect(pool.vacuumed).toBe(true);
    expect(pool.queries.join('\n')).not.toContain('VACUUM FULL');

    const csv = (await unzip(await readFile(result.archiveFiles[0]!))).toString('utf-8');
    expect(csv).toContain('global_sequence,event_id,session_id');
    expect(csv).toContain('event-10');
    expect(csv).toContain('event-11');
  });
});

function row(sequence: string, eventType: string): ArchiveRow {
  return {
    global_sequence: sequence,
    event_id: `event-${sequence}`,
    session_id: 'session-1',
    session_sequence: sequence,
    run_id: 'run-1',
    tenant_id: 'tenant-1',
    event_type: eventType,
    timestamp: '2026-07-07T00:00:00.000Z',
    event_json: { id: `event-${sequence}`, type: eventType, sessionId: 'session-1', runId: 'run-1' },
  };
}

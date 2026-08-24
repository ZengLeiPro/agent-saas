import { describe, expect, it, vi } from 'vitest';

import {
  dropDeadIndexes,
  evaluateDropRecheck,
  evaluateObservationWindow,
  evaluateZeroScanEvidence,
  formatExecuteDropAuthorizationAudit,
  isSessionReplacementIndex,
  normalizeAuthorizationRef,
  parseArgs,
  sameIndexDefinitionIgnoringName,
} from '../scripts/runtime-events-maintenance.mjs';

describe('runtime events maintenance DROP gates', () => {
  const observedUntil = '2026-08-24T00:00:00.000Z';

  it('fails closed when stats_reset or explicit evidence start is missing', () => {
    expect(evaluateObservationWindow({
      statsReset: null,
      evidenceObservedFrom: '2026-08-01T00:00:00.000Z',
      observedUntil,
    })).toMatchObject({ allowed: false, blocker: expect.stringContaining('stats_reset 缺失') });

    expect(evaluateObservationWindow({
      statsReset: '2026-08-01T00:00:00.000Z',
      evidenceObservedFrom: null,
      observedUntil,
    })).toMatchObject({ allowed: false, blocker: expect.stringContaining('--index-observed-from') });
  });

  it('uses the later of stats reset and evidence start and requires seven complete days', () => {
    const tooNewReset = evaluateObservationWindow({
      statsReset: '2026-08-20T00:00:00.000Z',
      evidenceObservedFrom: '2026-08-01T00:00:00.000Z',
      observedUntil,
    });
    expect(tooNewReset).toMatchObject({ allowed: false, blocker: expect.stringContaining('stats_reset 太新') });

    const tooShortEvidence = evaluateObservationWindow({
      statsReset: '2026-08-01T00:00:00.000Z',
      evidenceObservedFrom: '2026-08-20T00:00:00.000Z',
      observedUntil,
    });
    expect(tooShortEvidence).toMatchObject({ allowed: false, blocker: expect.stringContaining('索引观测窗口不足') });

    expect(evaluateObservationWindow({
      statsReset: '2026-08-01T00:00:00.000Z',
      evidenceObservedFrom: '2026-08-17T00:00:00.000Z',
      observedUntil,
    })).toMatchObject({ allowed: true, observedFrom: new Date('2026-08-17T00:00:00.000Z') });
  });

  it('requires explicit zero-scan statistics for every candidate index', () => {
    expect(evaluateZeroScanEvidence({ indexName: 'runtime_events_session_idx', idxScan: null }))
      .toContain('缺少 pg_stat_user_indexes');
    expect(evaluateZeroScanEvidence({ indexName: 'runtime_events_session_idx', idxScan: 1n }))
      .toContain('idx_scan=1');
    expect(evaluateZeroScanEvidence({ indexName: 'runtime_events_session_idx', idxScan: 0n })).toBeNull();
  });

  it('accepts only usable non-partial btree session replacement indexes', () => {
    const valid = {
      indexName: 'runtime_events_session_sequence_key',
      indexDef: 'CREATE UNIQUE INDEX runtime_events_session_sequence_key ON runtime_events USING btree (session_id, session_sequence)',
      accessMethod: 'btree',
      firstKey: 'session_id',
      isValid: true,
      isReady: true,
      isPartial: false,
    };
    expect(isSessionReplacementIndex(valid)).toBe(true);
    expect(isSessionReplacementIndex({ ...valid, isPartial: true })).toBe(false);
    expect(isSessionReplacementIndex({ ...valid, firstKey: 'run_id' })).toBe(false);
    expect(isSessionReplacementIndex({ ...valid, accessMethod: 'hash' })).toBe(false);
  });

  it('keeps trimmed authorization and observation evidence mandatory for execute-drop', () => {
    expect(() => parseArgs(['--execute-drop', '--index-observed-from', '2026-08-01T00:00:00Z'], '/tmp'))
      .toThrow('--authorization-ref');
    expect(() => parseArgs([
      '--execute-drop',
      '--authorization-ref', '',
      '--index-observed-from', '2026-08-01T00:00:00Z',
    ], '/tmp')).toThrow('--authorization-ref');
    expect(() => parseArgs([
      '--execute-drop',
      '--authorization-ref', '   ',
      '--index-observed-from', '2026-08-01T00:00:00Z',
    ], '/tmp')).toThrow('--authorization-ref');
    expect(() => parseArgs(['--execute-drop', '--authorization-ref', 'CHG-198'], '/tmp'))
      .toThrow('--index-observed-from');
    expect(parseArgs([
      '--execute-drop',
      '--authorization-ref', '  CHG-198  ',
      '--index-observed-from', '2026-08-01T00:00:00Z',
    ], '/tmp')).toMatchObject({
      executeDrop: true,
      authorizationRef: 'CHG-198',
      indexObservedFrom: '2026-08-01T00:00:00Z',
    });
  });

  it('normalizes authorization references before execute-drop audit output and rejects blank values', () => {
    expect(normalizeAuthorizationRef('  CHG-198  ')).toBe('CHG-198');
    expect(normalizeAuthorizationRef(' \t ')).toBeUndefined();
    expect(formatExecuteDropAuthorizationAudit('  CHG-198  '))
      .toBe('[authorization] execute-drop authorizationRef=CHG-198');
    expect(() => formatExecuteDropAuthorizationAudit(' \n ')).toThrow('trim 后非空');
  });

  it('fails execute-drop before any database call when authorization is blank', async () => {
    const query = vi.fn();
    const target = { query } as unknown as Parameters<typeof dropDeadIndexes>[0];
    await expect(dropDeadIndexes(target, 'runtime_events', {
      dropRunIdx: false,
      indexObservedFrom: '2026-08-01T00:00:00Z',
      authorizationRef: '   ',
    })).rejects.toThrow('trim 后非空');
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an actually equivalent replacement before optional run index removal', () => {
    const run = 'CREATE INDEX runtime_events_run_idx ON public.runtime_events USING btree (run_id)';
    const equivalent = 'CREATE INDEX runtime_events_session_run_idx ON public.runtime_events USING btree (run_id)';
    const different = 'CREATE INDEX runtime_events_session_run_idx ON public.runtime_events USING btree (session_id, run_id)';
    expect(sameIndexDefinitionIgnoringName(run, equivalent, 'runtime_events_run_idx', 'runtime_events_session_run_idx')).toBe(true);
    expect(sameIndexDefinitionIgnoringName(run, different, 'runtime_events_run_idx', 'runtime_events_session_run_idx')).toBe(false);
  });

  it('fails a per-DROP recheck on reset, scan, replacement state, or definition drift', () => {
    const candidate = {
      indexName: 'runtime_events_session_idx',
      indexDef: 'CREATE INDEX runtime_events_session_idx ON runtime_events USING btree (session_id)',
      idxScan: 0n,
    };
    const replacement = {
      indexName: 'runtime_events_session_sequence_key',
      indexDef: 'CREATE UNIQUE INDEX runtime_events_session_sequence_key ON runtime_events USING btree (session_id, session_sequence)',
      accessMethod: 'btree',
      firstKey: 'session_id',
      isValid: true,
      isReady: true,
      isPartial: false,
    };
    const blockers = evaluateDropRecheck({
      baselineStatsReset: '2026-08-01T00:00:00.000Z',
      currentStatsReset: '2026-08-02T00:00:00.000Z',
      evidenceObservedFrom: '2026-08-01T00:00:00.000Z',
      observedUntil,
      expectedCandidates: [candidate],
      currentCandidates: [{ ...candidate, indexDef: `${candidate.indexDef} DESC`, idxScan: 1n }],
      expectedReplacements: [replacement],
      currentReplacements: [{ ...replacement, indexDef: `${replacement.indexDef} INCLUDE (event_id)` }],
    });
    expect(blockers.join('\n')).toContain('stats_reset 自整批初次取证后发生变化');
    expect(blockers.join('\n')).toContain('idx_scan=1');
    expect(blockers.join('\n')).toContain('定义自整批初次取证后发生变化');
    expect(blockers.join('\n')).toContain('替代索引定义自整批初次取证后发生变化');

    expect(evaluateDropRecheck({
      baselineStatsReset: '2026-08-01T00:00:00.000Z',
      currentStatsReset: '2026-08-01T00:00:00.000Z',
      evidenceObservedFrom: '2026-08-01T00:00:00.000Z',
      observedUntil,
      expectedCandidates: [candidate],
      currentCandidates: [candidate],
      expectedReplacements: [replacement],
      currentReplacements: [{ ...replacement, isReady: false }],
    }).join('\n')).toContain('替代索引缺失、失效、未 ready 或变为 partial');
  });

  it('holds a session advisory lock and stops later DROP when a recheck observes stats reset', async () => {
    const reset = '2026-08-01T00:00:00.000Z';
    const candidates = [
      {
        index_name: 'runtime_events_event_json_gin_idx',
        index_def: 'CREATE INDEX runtime_events_event_json_gin_idx ON runtime_events USING gin (event_json)',
        idx_scan: '0',
      },
      {
        index_name: 'runtime_events_session_idx',
        index_def: 'CREATE INDEX runtime_events_session_idx ON runtime_events USING btree (session_id)',
        idx_scan: '0',
      },
    ];
    const replacement = {
      index_name: 'runtime_events_session_sequence_key',
      index_def: 'CREATE UNIQUE INDEX runtime_events_session_sequence_key ON runtime_events USING btree (session_id, session_sequence)',
      access_method: 'btree',
      first_key: 'session_id',
      is_valid: true,
      is_ready: true,
      is_partial: false,
    };
    let clockReads = 0;
    const sqlCalls: string[] = [];
    const target = {
      query: vi.fn(async (query: string, values?: unknown[]) => {
        sqlCalls.push(query);
        if (query.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
        if (query.includes('pg_advisory_lock')) return { rows: [{}] };
        if (query.includes('pg_stat_database')) {
          clockReads += 1;
          return {
            rows: [{
              observed_until: observedUntil,
              stats_reset: clockReads >= 3 ? '2026-08-02T00:00:00.000Z' : reset,
            }],
          };
        }
        if (query.includes('LEFT JOIN pg_stat_user_indexes')) {
          const requested = (values?.[1] as string[]) ?? [];
          return { rows: candidates.filter((item) => requested.includes(item.index_name)) };
        }
        if (query.includes('JOIN pg_am')) return { rows: [replacement] };
        if (query.startsWith('DROP INDEX CONCURRENTLY')) return { rows: [] };
        throw new Error(`unexpected query: ${query}`);
      }),
    } as unknown as Parameters<typeof dropDeadIndexes>[0];

    await expect(dropDeadIndexes(target, 'runtime_events', {
      dropRunIdx: false,
      indexObservedFrom: reset,
      authorizationRef: 'CHG-198',
    })).rejects.toThrow('stats_reset 自整批初次取证后发生变化');

    expect(sqlCalls.filter((sql) => sql.startsWith('DROP INDEX CONCURRENTLY'))).toHaveLength(1);
    expect(sqlCalls[0]).toContain('pg_advisory_lock');
    expect(sqlCalls.at(-1)).toContain('pg_advisory_unlock');
  });
});

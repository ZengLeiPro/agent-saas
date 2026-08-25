import { describe, expect, it } from 'vitest';

import { parseReplayArgs } from '../../scripts/context-derived-replay.mjs';
import { parseRelationEvalArgs } from './context-relation-eval.mjs';

describe('Context operation CLI contracts', () => {
  it('keeps derived replay dry-run by default and requires explicit apply inputs', () => {
    expect(parseReplayArgs(['--tenant=tenant-a', '--table-prefix=agent_runtime'])).toEqual({
      tenantId: 'tenant-a', tablePrefix: 'agent_runtime',
      consumerId: 'context-deterministic-projector-v1', apply: false,
    });
    expect(parseReplayArgs([
      '--tenant=tenant-a', '--table-prefix=agent_runtime', '--consumer=projector-v2',
      '--expected-cursor=42', '--confirm-tenant=tenant-a', '--apply',
    ])).toMatchObject({
      tenantId: 'tenant-a', consumerId: 'projector-v2', expectedCursorSeq: '42',
      confirmTenantId: 'tenant-a', apply: true,
    });
    expect(() => parseReplayArgs(['--tenant=tenant-a'])).toThrow('table-prefix');
    expect(() => parseReplayArgs([
      '--tenant=tenant-a', '--table-prefix=agent_runtime', '--expected-cursor=-1',
    ])).toThrow('非负整数');
  });

  it('requires a fixed dataset and accepts an optional report path', () => {
    expect(parseRelationEvalArgs(['--dataset=fixtures/context-relations.json'])).toEqual({
      dataset: 'fixtures/context-relations.json',
    });
    expect(parseRelationEvalArgs(['--dataset=data.json', '--output=report.json'])).toEqual({
      dataset: 'data.json', output: 'report.json',
    });
    expect(() => parseRelationEvalArgs([])).toThrow('dataset');
  });
});

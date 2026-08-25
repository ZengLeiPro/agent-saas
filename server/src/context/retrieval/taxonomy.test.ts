import { describe, expect, it } from 'vitest';

import { contextDisplayKind, normalizeContextFilterValues } from './taxonomy.js';

describe('Context taxonomy', () => {
  it('normalizes filters with NFKC, trimming, case folding and stable dedupe', () => {
    expect(normalizeContextFilterValues([' Task ', 'task', 'ＴＡＳＫ', 'taskboard-tasks']))
      .toEqual(['task', 'taskboard-tasks']);
  });

  it('prefers business entity kinds while retaining storage kinds elsewhere', () => {
    expect(contextDisplayKind('project', 'snapshot')).toBe('Project');
    expect(contextDisplayKind(undefined, 'event')).toBe('event');
  });
});

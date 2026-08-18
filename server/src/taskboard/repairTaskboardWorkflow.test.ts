import { describe, expect, it } from 'vitest';

import { parseWorkflowRepairArgs } from '../../scripts/repairTaskboardWorkflow.js';
import { TASKBOARD_TABLE_PREFIX_MAX_LENGTH } from './storeHelpers.js';

describe('taskboard workflow repair arguments', () => {
  it('uses the Store identifier sanitizer and rejects an overlong prefix before database access', () => {
    expect(() => parseWorkflowRepairArgs([
      `--table-prefix=${'a'.repeat(TASKBOARD_TABLE_PREFIX_MAX_LENGTH + 1)}`,
    ])).toThrow(/prefix is too long/);
    expect(parseWorkflowRepairArgs([
      `--table-prefix=${'a'.repeat(TASKBOARD_TABLE_PREFIX_MAX_LENGTH)}`,
      '--task-id=remediation-1',
      '--dry-run',
    ])).toMatchObject({ taskId: 'remediation-1', apply: false });
  });
});

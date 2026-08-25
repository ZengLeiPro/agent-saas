import { describe, expect, it } from 'vitest';

import type { ResourceAssignmentSet } from '../data/assignments/index.js';
import { knowledgeSuites } from './governanceMemoryRoutes.js';

const NOW = '2026-08-25T12:00:00.000Z';
function set(resourceId: string): ResourceAssignmentSet {
  return {
    tenantId: 'tenant-a', resourceType: 'org_knowledge', resourceId, resourceName: resourceId,
    status: 'enabled', source: 'governance', version: 1, assignments: [],
    createdAt: NOW, createdBy: 'admin-a', updatedAt: NOW, updatedBy: 'admin-a',
  };
}

describe('knowledgeSuites manifest', () => {
  it('缺少必需 Taskboard Collection 时明确 incomplete', () => {
    const [suite] = knowledgeSuites([set('taskboard-projects'), set('taskboard-tasks')], true);
    expect(suite).toMatchObject({ suiteId: 'taskboard', completeness: 'incomplete',
      missingResourceIds: ['taskboard-events'], unknownResourceIds: [] });
  });

  it('未知 Taskboard Collection 不会被静默拆成普通资源', () => {
    const suites = knowledgeSuites([
      set('taskboard-projects'), set('taskboard-tasks'), set('taskboard-events'),
      set('taskboard-comments'), set('directory-people'),
    ], true);
    expect(suites[0]).toMatchObject({ suiteId: 'taskboard', completeness: 'attention',
      unknownResourceIds: ['taskboard-comments'],
      resourceIds: ['taskboard-projects', 'taskboard-tasks', 'taskboard-events', 'taskboard-comments'] });
    expect(suites[1]).toMatchObject({ suiteId: 'resource:directory-people', completeness: 'complete' });
  });
});

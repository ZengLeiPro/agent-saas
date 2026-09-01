import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeWorkflowPosition,
  WorkflowDisplayPolicyConflictError,
  WorkflowDisplayPolicyStore,
} from './store.js';

describe('WorkflowDisplayPolicyStore', () => {
  let directory = '';
  let store: WorkflowDisplayPolicyStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'workflow-display-'));
    store = new WorkflowDisplayPolicyStore(join(directory, 'policies.json'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('按个人、岗位、组织、平台顺序解析，并规范化岗位名称', async () => {
    expect(normalizeWorkflowPosition('  Sales   Manager ')).toBe('sales manager');
    expect(store.resolve({ tenantId: 'acme', userId: 'u1', position: '销售' })).toMatchObject({
      source: 'platform',
      displayCount: 3,
      workflowIds: [],
      revision: 0,
    });
    await store.upsert({
      tenantId: 'acme',
      scope: 'tenant',
      subjectId: 'acme',
      subjectLabel: 'Acme',
      displayCount: 2,
      workflowIds: ['a', 'b'],
      expectedRevision: 0,
      actorId: 'admin',
    });
    await store.upsert({
      tenantId: 'acme',
      scope: 'position',
      subjectId: '销售',
      subjectLabel: '销售',
      displayCount: 1,
      workflowIds: ['sales'],
      expectedRevision: 0,
      actorId: 'admin',
    });
    await store.upsert({
      tenantId: 'acme',
      scope: 'user',
      subjectId: 'u1',
      subjectLabel: '张三',
      displayCount: 1,
      workflowIds: ['personal'],
      expectedRevision: 0,
      actorId: 'admin',
    });

    expect(store.resolve({ tenantId: 'acme', userId: 'u1', position: ' 销售 ' })).toMatchObject({
      source: 'user',
      workflowIds: ['personal'],
    });
    expect(store.resolve({ tenantId: 'acme', userId: 'u2', position: ' 销售 ' })).toMatchObject({
      source: 'position',
      workflowIds: ['sales'],
    });
    expect(store.resolve({ tenantId: 'acme', userId: 'u3' })).toMatchObject({
      source: 'tenant',
      workflowIds: ['a', 'b'],
    });
  });

  it('用 revision 阻止覆盖更新，并支持恢复继承', async () => {
    const created = await store.upsert({
      tenantId: 'acme',
      scope: 'tenant',
      subjectId: 'acme',
      subjectLabel: 'Acme',
      displayCount: 1,
      workflowIds: ['a'],
      expectedRevision: 0,
      actorId: 'admin',
    });
    await expect(
      store.upsert({
        tenantId: 'acme',
        scope: 'tenant',
        subjectId: 'acme',
        subjectLabel: 'Acme',
        displayCount: 1,
        workflowIds: ['b'],
        expectedRevision: 0,
        actorId: 'admin',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkflowDisplayPolicyConflictError>>({ currentRevision: 1 }),
    );

    await expect(
      store.remove({
        tenantId: 'acme',
        scope: 'tenant',
        subjectId: 'acme',
        expectedRevision: created.revision,
      }),
    ).resolves.toBe(true);
    expect(store.resolve({ tenantId: 'acme', userId: 'u1' }).source).toBe('platform');
  });

  it('组织之间严格隔离', async () => {
    await store.upsert({
      tenantId: 'a',
      scope: 'user',
      subjectId: 'same-user',
      subjectLabel: '成员',
      displayCount: 1,
      workflowIds: ['only-a'],
      expectedRevision: 0,
      actorId: 'admin',
    });
    expect(store.resolve({ tenantId: 'a', userId: 'same-user' }).workflowIds).toEqual(['only-a']);
    expect(store.resolve({ tenantId: 'b', userId: 'same-user' }).source).toBe('platform');
  });
});

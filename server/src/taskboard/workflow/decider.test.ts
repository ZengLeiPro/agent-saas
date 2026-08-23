import { describe, expect, it } from 'vitest';
import type { TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import { decideTransition } from './decider.js';
import { resolveWorkflowContract } from '../workflowContract.js';
const task = (patch: Partial<TaskBoardTask> = {}): TaskBoardTask => ({ id:'t',boardId:'b',identifier:'TASK-1',title:'x',description:'',kind:'delivery',status:'in_progress',priority:'none',labels:[],sortOrder:1,commentCount:0,creatorUserId:'u',creatorName:'u',version:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',...patch });
describe('direct workflow transitions', () => {
  it('accepts delivery work review/blocked only', () => {
    expect(decideTransition(task(), 'work', 'in_review', { hasMergeFact:false })).toEqual({ toStatus:'in_review' });
    expect(() => decideTransition(task(), 'work', 'done', { hasMergeFact:false })).toThrow();
  });
  it('maps remediation review approval directly to done', () => {
    const remediation = task({kind:'remediation',status:'in_review'});
    expect(decideTransition(remediation, 'review', 'ready_to_merge', {hasMergeFact:false})).toEqual({toStatus:'done'});
    expect(decideTransition(remediation, 'review', 'done', {hasMergeFact:false})).toEqual({toStatus:'done'});
  });
  it('only lets legacy integration merge finish after a complete merge fact', () => {
    const integration = task({ kind: 'integration', status: 'in_progress', workflowVersion: 2 });
    expect(() => decideTransition(integration, 'merge', 'done', { hasMergeFact: false })).toThrow();
    expect(decideTransition(integration, 'merge', 'done', { hasMergeFact: true })).toEqual({ toStatus: 'done' });
    expect(decideTransition({ ...integration, status: 'done' }, 'merge', 'done', { hasMergeFact: true })).toEqual({ toStatus: 'done' });
    expect(() => decideTransition(integration, 'merge', 'in_progress', { hasMergeFact: true })).toThrow();
  });
  it('exposes allowedStatuses without evidence fields', () => {
    expect(resolveWorkflowContract(task(), 'work').allowedStatuses).toEqual(['in_review','blocked']);
  });
});

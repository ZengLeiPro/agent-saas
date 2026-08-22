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
    expect(decideTransition(task({kind:'remediation',status:'in_review'}), 'review', 'done', {hasMergeFact:false})).toEqual({toStatus:'done'});
  });
  it('exposes allowedStatuses without evidence fields', () => {
    expect(resolveWorkflowContract(task(), 'work').allowedStatuses).toEqual(['in_review','blocked']);
  });
});

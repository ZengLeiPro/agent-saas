import { describe, expect, it } from 'vitest';

import { parseOrgAgentRuntimePolicy } from '../../data/orgAgents/runtimePolicy.js';
import { buildOrgAgentSkillFilter } from '../orgAgentSkillFilter.js';
import {
  createOrgAgentEffectiveExecutionContext,
  executionContextInstructions,
  executionContextSessionSnapshot,
  parseOrgAgentEffectiveExecutionContext,
} from './orgAgentExecutionContext.js';

function fixture(revision: number, instruction: string, skillId: string) {
  const runtime = parseOrgAgentRuntimePolicy({
    schemaVersion: 1,
    workerModel: { strategy: 'fixed', modelRef: `models/worker-${revision}` },
  });
  const binding = {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    bindingId: 'binding-1',
    revision,
    effectiveConfig: {},
  } as never;
  const channel = {
    bindingId: 'binding-1',
    workConversationId: 'conversation-1',
    policyRevision: revision,
    allowedToolNames: ['ContextSearch'],
    allowedSkillIds: [skillId],
    allowedSourceIds: ['knowledge-1'],
    dwsResourceIds: ['doc:1'],
    contextEnabled: true,
    sharedContext: {
      instructions: `群指令-${revision}`,
      memories: [
        {
          memoryId: 'memory-1',
          scope: 'conversation' as const,
          content: { rule: `记忆-${revision}` },
          policyRevision: revision,
          version: revision,
        },
      ],
    },
  } as never;
  return createOrgAgentEffectiveExecutionContext({
    binding,
    channel,
    agent: {
      id: 'agent-1',
      tenantId: 'tenant-1',
      name: '采购员工',
      instructions: instruction,
      allowedSkills: [skillId],
      allowedKnowledge: ['knowledge-1'],
      runtime,
      enabled: true,
      updatedAt: `2026-09-0${revision}T00:00:00.000Z`,
    } as never,
    systemContext: `合成上下文-${revision}`,
    modelRef: `models/worker-${revision}`,
    goal: `目标-${revision}`,
    acceptance: [`验收-${revision}`],
  });
}

describe('OrgAgent effective execution context', () => {
  it('pins group instructions and governed memories deterministically for F03', () => {
    const context = fixture(1, '员工指令-1', 'skill-v1');
    const restored = parseOrgAgentEffectiveExecutionContext({ executionContext: context });
    expect(restored.channel).toMatchObject({
      instructions: '群指令-1',
      systemContext: '合成上下文-1',
      memories: [
        { memoryId: 'memory-1', content: { rule: '记忆-1' }, policyRevision: 1, version: 1 },
      ],
    });
    expect(executionContextInstructions(restored)).toContain(
      '员工指令-1\n\n群指令-1\n\n合成上下文-1',
    );
  });

  it('uses current config for a new task while a retry keeps the old WorkOrder snapshot for F05', () => {
    const oldTask = fixture(1, '员工指令-1', 'skill-v1');
    const newTask = fixture(2, '员工指令-2', 'skill-v2');
    expect(parseOrgAgentEffectiveExecutionContext({ executionContext: oldTask })).toMatchObject({
      revisions: { binding: 1 },
      agent: { instructions: '员工指令-1' },
    });
    expect(parseOrgAgentEffectiveExecutionContext({ executionContext: newTask })).toMatchObject({
      revisions: { binding: 2 },
      agent: { instructions: '员工指令-2' },
    });
    expect(
      parseOrgAgentEffectiveExecutionContext({ executionContext: oldTask }).model.modelRef,
    ).toBe('models/worker-1');
  });

  it('drives the worker skill filter from the binding snapshot for F10', () => {
    const snapshot = executionContextSessionSnapshot(fixture(2, '员工指令-2', 'bound-skill'));
    const allows = buildOrgAgentSkillFilter(snapshot);
    expect(allows({ id: 'bound-skill' } as never)).toBe(true);
    expect(allows({ id: 'knowledge-1' } as never)).toBe(false);
    expect(allows({ id: 'stale-session-skill' } as never)).toBe(false);
  });

  it('fails closed when a legacy WorkOrder has no execution context', () => {
    expect(() => parseOrgAgentEffectiveExecutionContext({ revision: 1 })).toThrow(
      'ORG_AGENT_EXECUTION_CONTEXT_MISSING_OR_INVALID',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createOrgAgentDispatcherRuntimeValidator } from '../app/orgAgentDispatcherRuntime.js';
import { parseAgentRuntimeProfileConfig } from '../data/agentProfiles/types.js';
import {
  DEFAULT_ORG_AGENT_RUNTIME_POLICY,
  orgAgentRuntimePolicySchema,
} from '../data/orgAgents/runtimePolicy.js';

const profileConfig = parseAgentRuntimeProfileConfig({
  schemaVersion: 1,
  context: { systemInstructions: '', modules: [] },
  skills: { defaultSkillIds: [], allowlist: null, denylist: [] },
  mcp: { serverAllowlist: null, toolAllowlist: null, denyServers: [], denyTools: [] },
  memory: { scope: 'none' },
  model: { strategy: 'inherit' },
  limits: { maxTurns: 10 },
  capabilities: {
    shell: true,
    backgroundTasks: true,
    interaction: true,
    subagents: true,
    scheduling: false,
  },
  tools: { allowlist: ['Agent', 'BackgroundTask'], denylist: [] },
  execution: { allowedTargets: null },
});

function profileResolver() {
  return {
    resolveForSession: vi.fn().mockResolvedValue({ version: { config: profileConfig } }),
  };
}

describe('Org Agent dispatcher runtime readiness', () => {
  it('Worker default 策略按自身 modelRef 验证，不误用组织默认模型', async () => {
    const modelResolver = vi.fn((ref: string) =>
      ref === 'group/worker-default'
        ? { model: 'provider/worker', connection: { apiKey: 'test-key' } }
        : null,
    );
    const validate = createOrgAgentDispatcherRuntimeValidator({
      backgroundTasks: {} as never,
      profileResolver: profileResolver() as never,
      defaultModelResolver: () => ({ ref: 'group/tenant-default' }),
      modelResolver,
    });
    const policy = orgAgentRuntimePolicySchema.parse({
      ...structuredClone(DEFAULT_ORG_AGENT_RUNTIME_POLICY),
      executionMode: 'dispatcher',
      workerModel: { strategy: 'default', modelRef: 'group/worker-default' },
    });

    await expect(validate('tenant-1', policy)).resolves.toEqual([]);
    expect(modelResolver).toHaveBeenCalledTimes(2);
    expect(modelResolver).toHaveBeenCalledWith('group/worker-default', 'tenant-1');
    expect(modelResolver).not.toHaveBeenCalledWith('group/tenant-default', 'tenant-1');
  });
});

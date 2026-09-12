import { beforeEach, describe, expect, it } from 'vitest';

import { createBuiltinAgentProfileRecords } from '../data/agentProfiles/builtins.js';
import { InMemoryAgentRuntimeProfileStore } from '../data/agentProfiles/store.js';
import { AgentRuntimeProfileResolver } from '../runtime/agentProfiles.js';
import { resolveBackgroundSubagentProfile } from '../runtime/background/backgroundSubagentProfile.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';

describe('background subagent continuation Profile', () => {
  let resolver: AgentRuntimeProfileResolver;
  let previous: RuntimeSessionRecord;

  beforeEach(async () => {
    const store = new InMemoryAgentRuntimeProfileStore();
    await store.init();
    resolver = new AgentRuntimeProfileResolver(store);
    const records = createBuiltinAgentProfileRecords('2026-09-12T00:00:00.000Z');
    const v2 = records.versions.find(
      (version) => version.profileVersionId === 'arpv_builtin_subagent_explore_v2',
    )!;
    previous = {
      sessionId: 'old-child-session',
      userId: 'user-1',
      username: 'alice',
      userRole: 'user',
      tenantId: 'tenant-1',
      channel: 'web',
      cwd: '/tmp/workspace',
      transcriptPath: '/tmp/workspace/transcript.jsonl',
      modelRef: 'group/model',
      executionTarget: 'server-local',
      status: 'finished',
      kind: 'subagent',
      memoryPolicyVersion: 'v1',
      memoryAutomationEligible: false,
      sandboxWorkloadDescriptor: { kind: 'interactive' },
      profileBindingKey: 'background_explore',
      profileId: v2.profileId,
      profileVersionId: v2.profileVersionId,
      profileConfigDigest: v2.configDigest,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:01:00.000Z',
    };
  });

  function catalog(record: RuntimeSessionRecord | null): SessionCatalog {
    return { get: async () => record } as unknown as SessionCatalog;
  }

  it('新 background attempt 继续使用旧物理会话 pin 的 Explore v2', async () => {
    const profile = await resolveBackgroundSubagentProfile({
      config: {
        agentCwd: '/tmp/workspace',
        sharedDir: '/tmp/shared',
        agentRuntimeProfileResolver: resolver,
      },
      sessionCatalog: catalog(previous),
      request: {
        description: '继续调研',
        prompt: '补充结论',
        agentType: 'explore',
        continuation: {
          previousSessionId: previous.sessionId,
          previousRunId: 'old-run',
          sequence: 1,
        },
        includeCompanyInfo: false,
      },
      tenantId: 'tenant-1',
      userId: 'user-1',
      executionTarget: 'server-local',
    });
    expect(profile?.version.profileVersionId).toBe('arpv_builtin_subagent_explore_v2');
    expect(profile?.version.config.tools.allowlist).not.toContain('Write');
  });

  it('历史会话删除或身份变化时 fail closed', async () => {
    for (const record of [
      { ...previous, deletedAt: '2026-09-12T01:00:00.000Z' },
      { ...previous, tenantId: 'tenant-2' },
      { ...previous, userId: 'user-2' },
      null,
    ]) {
      await expect(
        resolveBackgroundSubagentProfile({
          config: {
            agentCwd: '/tmp/workspace',
            sharedDir: '/tmp/shared',
            agentRuntimeProfileResolver: resolver,
          },
          sessionCatalog: catalog(record),
          request: {
            description: '继续调研',
            prompt: '补充结论',
            agentType: 'explore',
            continuation: { previousSessionId: previous.sessionId },
            includeCompanyInfo: false,
          },
          tenantId: 'tenant-1',
          userId: 'user-1',
          executionTarget: 'server-local',
        }),
      ).rejects.toThrow(/不存在、已删除或身份不一致/);
    }
  });
});

import { describe, expect, it } from 'vitest';

import { buildRuntimeSkillFilter, resolveSkillContextUsername } from '../runtime/rawRuntimeRunDispatch.js';
import type { HandRecord } from '../runtime/handStore.js';
import type { ChannelContext } from '../types/index.js';

describe('resolveSkillContextUsername', () => {
  it('uses the session owner when present so resumed runs keep the same skill scope as instructions', () => {
    const context: ChannelContext = {
      channel: 'web',
      user: { id: 'admin-1', username: 'admin', role: 'admin' },
      sessionOwner: { id: 'user-1', username: 'alice', role: 'user' },
    };

    expect(resolveSkillContextUsername(context)).toBe('alice');
  });

  it('falls back to the authenticated user for normal user-owned chats', () => {
    const context: ChannelContext = {
      channel: 'web',
      user: { id: 'admin-1', username: 'admin', role: 'admin' },
    };

    expect(resolveSkillContextUsername(context)).toBe('admin');
  });
});

describe('buildRuntimeSkillFilter', () => {
  const browserSkill = { id: 'browser', name: 'browser', description: 'Browser automation' };
  const docSkill = { id: 'docx', name: 'docx', description: 'Word documents' };

  it('hides browser skill for an ACS hand without browser capability', () => {
    const filter = buildRuntimeSkillFilter([{
      handId: 'session:agent-saas-acs',
      sessionId: 'session',
      workspaceId: 'workspace',
      type: 'server-remote',
      status: 'ready',
      endpoint: 'http://10.0.1.1:3400',
      capabilities: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    } satisfies HandRecord]);

    expect(filter(browserSkill)).toBe(false);
    expect(filter(docSkill)).toBe(true);
  });

  it('keeps browser skill when the runtime explicitly exposes a browser capability', () => {
    const filter = buildRuntimeSkillFilter([{
      handId: 'session:agent-saas-acs',
      sessionId: 'session',
      workspaceId: 'workspace',
      type: 'server-remote',
      status: 'ready',
      endpoint: 'http://10.0.1.1:3400',
      capabilities: [{
        name: 'browser',
        description: 'Browser automation hand',
        tools: [],
        constraints: [],
        risk: 'safe',
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    } satisfies HandRecord]);

    expect(filter(browserSkill)).toBe(true);
  });

  it('keeps browser skill while the ACS hand is still provisioning (capability is a static declaration, not a probe result)', () => {
    // 回归锁定 2026-07-03 生产 bug：每轮 dispatch 都把 ACS hand upsert 回
    // provisioning 后毫秒级取快照构建 filter，若要求 ready，browser skill
    // 会在每一轮 run 的 <available-skills> 里被永久滤掉。
    const filter = buildRuntimeSkillFilter([{
      handId: 'session:agent-saas-acs',
      sessionId: 'session',
      workspaceId: 'workspace',
      type: 'server-remote',
      status: 'provisioning',
      endpoint: 'http://10.0.1.1:3400',
      capabilities: [{
        name: 'browser',
        description: 'Browser automation hand',
        tools: [],
        constraints: [],
        risk: 'safe',
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    } satisfies HandRecord]);

    expect(filter(browserSkill)).toBe(true);
    expect(filter(docSkill)).toBe(true);
  });

  it('hides browser skill when the browser-capable hand is unhealthy', () => {
    const filter = buildRuntimeSkillFilter([{
      handId: 'session:agent-saas-acs',
      sessionId: 'session',
      workspaceId: 'workspace',
      type: 'server-remote',
      status: 'unhealthy',
      endpoint: 'http://10.0.1.1:3400',
      capabilities: [{
        name: 'browser',
        description: 'Browser automation hand',
        tools: [],
        constraints: [],
        risk: 'safe',
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    } satisfies HandRecord]);

    expect(filter(browserSkill)).toBe(false);
    expect(filter(docSkill)).toBe(true);
  });
});

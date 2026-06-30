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
});

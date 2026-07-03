import { describe, expect, it } from 'vitest';

import { buildAvailableHandsPrompt } from '../runtime/handPrompt.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import { readFileToolDescriptor } from '../agent/toolRuntime.js';

describe('Runtime prompt and client daemon transport', () => {
  it('renders only the current runtime to the model', () => {
    const prompt = buildAvailableHandsPrompt([
      {
        handId: 'linux-main',
        sessionId: 's1',
        workspaceId: 'w1',
        type: 'server-remote',
        status: 'ready',
        capabilities: [{
          name: 'filesystem',
          description: 'Workspace filesystem',
          tools: [readFileToolDescriptor],
          constraints: ['read-only preferred'],
          risk: 'safe',
        }],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: {},
      },
      {
        handId: 'client-laptop',
        sessionId: 's1',
        workspaceId: 'w-client',
        type: 'client',
        status: 'ready',
        capabilities: [{
          name: 'customer_network',
          description: 'Customer-side network access',
          tools: [readFileToolDescriptor],
          constraints: ['reverse-connected only'],
          risk: 'safe',
        }],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: {},
      },
    ]);

    expect(prompt).toContain('<current-runtime status="ready" workspaceId="w1">');
    expect(prompt).not.toContain('id="linux-main"');
    expect(prompt).not.toContain('client-laptop');
    expect(prompt).not.toContain('type="client"');
    expect(prompt).not.toContain('customer_network');
  });

  it('does not expose fallback hands when a tenant runtime is ready', () => {
    const prompt = buildAvailableHandsPrompt([
      {
        handId: 'ws_kaiyan__ky50wfyptpafch:server-container',
        sessionId: 's1',
        workspaceId: 'ws_kaiyan__ky50wfyptpafch',
        type: 'server-container',
        status: 'ready',
        capabilities: [{
          name: 'filesystem',
          description: 'Local workspace filesystem',
          tools: [readFileToolDescriptor],
          constraints: [],
          risk: 'safe',
        }],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: {},
      },
      {
        handId: 's1:agent-saas-ecs',
        sessionId: 's1',
        workspaceId: 'ws_kaiyan__ky50wfyptpafch',
        type: 'server-remote',
        status: 'ready',
        endpoint: 'http://10.0.1.1:3300',
        capabilities: [{
          name: 'filesystem',
          description: 'NAS-backed workspace filesystem',
          tools: [readFileToolDescriptor],
          constraints: [],
          risk: 'safe',
        }],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: { tenantRemoteHandId: 'agent-saas-ecs' },
      },
    ]);

    expect(prompt).toContain('<current-runtime status="ready" workspaceId="ws_kaiyan__ky50wfyptpafch">');
    expect(prompt).not.toContain('s1:agent-saas-ecs');
    expect(prompt).not.toContain('ws_kaiyan__ky50wfyptpafch:server-container');
    expect(prompt).not.toContain('server-container');
    expect(prompt).not.toContain('endpoint');
    expect(prompt).not.toContain('currentDefault');
    expect(prompt).not.toContain('handId');
  });

  it('does not expose a ready internal fallback while the tenant runtime is provisioning', () => {
    const prompt = buildAvailableHandsPrompt([
      {
        handId: 'ws_kaiyan__ky50wfyptpafch:server-container',
        sessionId: 's1',
        workspaceId: 'ws_kaiyan__ky50wfyptpafch',
        type: 'server-container',
        status: 'ready',
        capabilities: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: {},
      },
      {
        handId: 's1:agent-saas-acs',
        sessionId: 's1',
        workspaceId: 'ws_kaiyan__ky50wfyptpafch',
        type: 'server-remote',
        status: 'provisioning',
        endpoint: 'http://10.0.1.1:3400',
        capabilities: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: { tenantRemoteHandId: 'agent-saas-acs' },
      },
    ]);

    expect(prompt).toContain('<current-runtime status="provisioning" workspaceId="ws_kaiyan__ky50wfyptpafch">');
    expect(prompt).not.toContain('server-container');
    expect(prompt).not.toContain('agent-saas-acs');
  });

  it('routes client invocations to reverse registered daemon connection by handId', async () => {
    const transport = new ClientDaemonTransport();
    transport.register({
      handId: 'client-laptop',
      capabilities: [{
        name: 'filesystem',
        description: 'Client filesystem',
        tools: [readFileToolDescriptor],
        constraints: [],
        risk: 'safe',
      }],
      invoke: async (request) => ({ status: 'success', content: `handled:${request.context.handId}:${request.toolName}` }),
    });

    await expect(transport.invoke({
      toolName: 'Read',
      input: { path: 'README.md' },
      context: {
        handId: 'client-laptop',
        workspace: { root: '/', executionTarget: 'client' },
      },
    })).resolves.toEqual({ status: 'success', content: 'handled:client-laptop:Read' });

    await expect(transport.invoke({
      toolName: 'Read',
      input: { path: 'README.md' },
      context: { workspace: { root: '/', executionTarget: 'client' } },
    })).resolves.toEqual({ status: 'error', error: 'client daemon invocation requires context.handId' });
  });
});

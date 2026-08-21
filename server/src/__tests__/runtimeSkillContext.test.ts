import { describe, expect, it } from 'vitest';

import {
  buildImageGenSkillFilter,
  buildRuntimeSkillFilter,
  resolveSkillContextTenantId,
  resolveSkillContextUsername,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import { buildAudioTranscribeSkillFilter } from '../runtime/audioTranscribeRuntime.js';
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

  it('keeps the service principal tenant when the username is not a member account', () => {
    const context: ChannelContext = {
      channel: 'dingtalk',
      sessionOwner: {
        id: 'adws-account-1',
        username: 'agent-dws:org-kaikai',
        role: 'user',
        tenantId: 'tenant-1',
      },
    };

    expect(resolveSkillContextUsername(context)).toBe('agent-dws:org-kaikai');
    expect(resolveSkillContextTenantId(context)).toBe('tenant-1');
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

describe('buildAudioTranscribeSkillFilter', () => {
  const audioSkill = { id: 'audio-transcribe', name: 'audio-transcribe', description: 'Audio transcription' };
  const docSkill = { id: 'docx', name: 'docx', description: 'Word documents' };
  const resolvedConfig = {
    enabled: true,
    sttConfig: { apiKey: 'key', ossAccessKeyId: 'id', ossAccessKeySecret: 'secret' },
    pricing: { creditsPerCall: 10, costYuanPerCall: 0.1 },
  };

  it('keeps the skill only when the direct tool is configured and enabled', () => {
    const enabled = buildAudioTranscribeSkillFilter({ audioTranscribeTools: resolvedConfig });
    expect(enabled(audioSkill)).toBe(true);

    const disabled = buildAudioTranscribeSkillFilter({
      audioTranscribeTools: resolvedConfig,
      toolControls: { tools: { AudioTranscribe: { enabled: false } } },
    });
    expect(disabled(audioSkill)).toBe(false);
    expect(disabled(docSkill)).toBe(true);
  });

  it('hides the skill when platform STT is unavailable', () => {
    const filter = buildAudioTranscribeSkillFilter({});
    expect(filter(audioSkill)).toBe(false);
    expect(filter(docSkill)).toBe(true);
  });
});

describe('buildImageGenSkillFilter', () => {
  const imageGenSkill = { id: 'image-gen', name: 'image-gen', description: 'AI image generation' };
  const docSkill = { id: 'docx', name: 'docx', description: 'Word documents' };

  function gateConfig(options: {
    tenantEnabled?: boolean;
    engineConfigured?: boolean;
    toolEnabled?: boolean;
  }): Pick<RawRuntimeRunDispatchConfig, 'imageGenTools' | 'toolControls' | 'tenantStore'> {
    return {
      imageGenTools: options.engineConfigured === false ? undefined : {
        gptImage2: {
          baseUrl: 'https://image.example/v1',
          apiKey: 'resolved-key',
        },
      },
      toolControls: options.toolEnabled === false
        ? { tools: { GenerateImage: { enabled: false } } }
        : undefined,
      tenantStore: {
        getSettings: () => ({ features: { imageGenEnabled: options.tenantEnabled === true } }),
      } as unknown as RawRuntimeRunDispatchConfig['tenantStore'],
    };
  }

  it('keeps image-gen only when engine, global tool and tenant grant are all enabled', () => {
    const enabled = buildImageGenSkillFilter(gateConfig({ tenantEnabled: true }), 'kaiyan');
    expect(enabled(imageGenSkill)).toBe(true);
    expect(enabled(docSkill)).toBe(true);
  });

  it.each([
    ['tenant grant is off', { tenantEnabled: false }],
    ['engine is missing', { tenantEnabled: true, engineConfigured: false }],
    ['global tool is off', { tenantEnabled: true, toolEnabled: false }],
  ])('hides image-gen when %s without affecting other skills', (_label, options) => {
    const filter = buildImageGenSkillFilter(gateConfig(options), 'kaiyan');
    expect(filter(imageGenSkill)).toBe(false);
    expect(filter(docSkill)).toBe(true);
  });
});

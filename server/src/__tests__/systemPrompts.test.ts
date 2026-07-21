import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { buildInstructions } from '../runtime/rawRuntimeRunDispatch.js';
import { SystemPromptRegistry } from '../runtime/systemPrompts.js';

const SHARED_DIR = resolve(import.meta.dirname, '../../../workspace-shared');

describe('system prompt registry', () => {
  it('lists all prompt types and hot-swaps overrides without rebuilding the registry', () => {
    const registry = new SystemPromptRegistry(SHARED_DIR, {
      'main.static': '旧静态提示语',
    });

    expect(registry.list()).toHaveLength(10);
    expect(registry.get('main.static')).toBe('旧静态提示语');
    expect(registry.list().find((item) => item.id === 'main.static')?.overridden).toBe(true);

    registry.replaceOverrides({ 'main.static': '新静态提示语' });
    expect(registry.get('main.static')).toBe('新静态提示语');

    registry.replaceOverrides({});
    expect(registry.get('main.static')).toContain('开沿科技');
    expect(registry.list().find((item) => item.id === 'main.static')?.overridden).toBe(false);
  });

  it('buildInstructions reads current overrides and still renders template variables', () => {
    const registry = new SystemPromptRegistry(SHARED_DIR, {
      'main.static': 'STATIC-V1',
      'main.dynamicShared': 'ORG={{COMPANY_INFO}}',
      'main.dynamicPersonal': 'USER={{CURRENT_USER}};AGENT={{AGENT_NAME}};CWD={{USER_CWD}}',
    });
    const build = () => buildInstructions({
      sharedDir: SHARED_DIR,
      tenantId: 'missing-tenant',
      agentName: '开开',
      userName: '曾磊',
      persona: '',
      cwd: '/tmp/workspace',
      executionTarget: 'server-local',
      memorySearchEnabled: false,
      isPlatformAdmin: true,
      getSystemPrompt: (id) => registry.get(id),
    });

    expect(build()).toContain('STATIC-V1');
    expect(build()).toContain('USER=曾磊;AGENT=开开;CWD=/tmp/workspace');

    registry.replaceOverrides({
      'main.static': 'STATIC-V2',
      'main.dynamicShared': 'ORG={{COMPANY_INFO}}',
      'main.dynamicPersonal': 'USER={{CURRENT_USER}}',
    });
    expect(build()).toContain('STATIC-V2');
    expect(build()).not.toContain('STATIC-V1');
  });

  it('config validation rejects unknown and empty prompt overrides', () => {
    expect(() => parseAppConfig({
      agent: {},
      server: {},
      systemPrompts: { 'main.unknown': 'x' },
    })).toThrow('systemPrompts');
    expect(() => parseAppConfig({
      agent: {},
      server: {},
      systemPrompts: { 'main.static': '   ' },
    })).toThrow('systemPrompts.main.static');
  });
});

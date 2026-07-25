import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { buildInstructions } from '../runtime/rawRuntimeRunDispatch.js';
import { SystemPromptRegistry } from '../runtime/systemPrompts.js';
import { SYSTEM_PROMPT_IDS } from '../systemPrompts/types.js';

const SHARED_DIR = resolve(import.meta.dirname, '../../../workspace-shared');

describe('system prompt registry', () => {
  it('lists all prompt types and hot-swaps overrides without rebuilding the registry', () => {
    const registry = new SystemPromptRegistry(SHARED_DIR, {
      'main.static': '旧静态提示语',
    });

    // 跟随 SYSTEM_PROMPT_IDS，不写死数量——registry.list() 的契约是"列全所有已注册
    // 提示语"，新增一个 id 不该让本用例失败；真正要守的是两者不脱节。
    expect(registry.list()).toHaveLength(SYSTEM_PROMPT_IDS.length);
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

  // 组织自定义规则（2026-07-25）。三条不变量：未配置的组织整段不出现、
  // 配置后正文进入 system prompt、Profile 去掉该模块即可关闭。
  describe('tenant instructions', () => {
    const roots: string[] = [];

    function sharedDirWithTenant(tenantId: string, instructions?: string): string {
      const root = mkdtempSync(join(tmpdir(), 'tenant-instructions-'));
      roots.push(root);
      mkdirSync(join(root, 'prompts'), { recursive: true });
      for (const name of ['static', 'dynamic-shared', 'dynamic-tenant', 'runtime-memory', 'dynamic-personal']) {
        copyFileSync(join(SHARED_DIR, 'prompts', `${name}.md`), join(root, 'prompts', `${name}.md`));
      }
      mkdirSync(join(root, 'tenants', tenantId), { recursive: true });
      if (instructions !== undefined) {
        writeFileSync(join(root, 'tenants', tenantId, 'instructions.md'), instructions, 'utf-8');
      }
      return root;
    }

    const build = (sharedDir: string, modules?: Parameters<typeof buildInstructions>[0]['contextModules']) =>
      buildInstructions({
        sharedDir,
        tenantId: 'acme',
        agentName: '开开',
        userName: '张三',
        persona: '',
        cwd: '/workspace',
        executionTarget: 'server-remote',
        memorySearchEnabled: false,
        isPlatformAdmin: false,
        ...(modules ? { contextModules: modules } : {}),
      });

    afterEach(() => {
      while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
    });

    it('未配置 instructions.md 时整段不注入', () => {
      const out = build(sharedDirWithTenant('acme'));
      expect(out).not.toContain('# 组织自定义规则');
    });

    it('内容为空白时同样不注入（不留空标题）', () => {
      const out = build(sharedDirWithTenant('acme', '   \n  '));
      expect(out).not.toContain('# 组织自定义规则');
    });

    it('配置后注入正文与覆盖声明', () => {
      const out = build(sharedDirWithTenant('acme', '对外回复统一使用 emoji。'));
      expect(out).toContain('# 组织自定义规则');
      expect(out).toContain('对外回复统一使用 emoji。');
      expect(out).toContain('以本节为准');
    });

    it('Profile 去掉 tenant_instructions 模块即可关闭', () => {
      const sharedDir = sharedDirWithTenant('acme', '对外回复统一使用 emoji。');
      const out = build(sharedDir, ['company_info', 'personal_context']);
      expect(out).not.toContain('# 组织自定义规则');
      expect(out).not.toContain('对外回复统一使用 emoji。');
    });
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

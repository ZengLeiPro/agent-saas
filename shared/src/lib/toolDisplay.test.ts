/**
 * toolDisplay.ts 测试（当前覆盖率低，重点补齐）
 *
 * 覆盖：
 * - 各命名策略（内部工具规范化 / MCP / Skill）单独行为 + 组合 resolver
 * - isSkillTool 各种协议/展示形态
 * - extractToolDescription / getToolDisplayInfo / getToolDisplayLabel 的
 *   description、file_path、pattern 三条 detail 提取路径 + 流式半截 JSON 兜底
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeInternalToolNameStrategy,
  resolveMcpToolNameStrategy,
  resolveSkillToolNameStrategy,
  composeToolNameResolver,
  resolveDisplayToolName,
  isSkillTool,
  extractToolDescription,
  getToolDisplayInfo,
  getToolDisplayLabel,
} from './toolDisplay';

const base = { toolId: 'id', toolInput: '' };

describe('normalizeInternalToolNameStrategy', () => {
  it('小写内部工具名规范化为标准大小写', () => {
    expect(normalizeInternalToolNameStrategy({ ...base, toolName: 'bash', currentName: 'bash' })).toBe('Bash');
    expect(normalizeInternalToolNameStrategy({ ...base, toolName: 'webfetch', currentName: 'webfetch' })).toBe('WebFetch');
  });

  it('已是标准名（映射后与自身相同）返回 undefined 表示不改写', () => {
    expect(normalizeInternalToolNameStrategy({ ...base, toolName: 'Bash', currentName: 'Bash' })).toBeUndefined();
  });

  it('未知工具名返回 undefined', () => {
    expect(normalizeInternalToolNameStrategy({ ...base, toolName: 'FooBar', currentName: 'FooBar' })).toBeUndefined();
  });
});

describe('resolveMcpToolNameStrategy', () => {
  it('mcp__server__tool → MCP:server/tool', () => {
    expect(resolveMcpToolNameStrategy({ ...base, toolName: '', currentName: 'mcp__cron__manage' })).toBe('MCP:cron/manage');
  });

  it('tool 段含双下划线时正确拼回', () => {
    expect(resolveMcpToolNameStrategy({ ...base, toolName: '', currentName: 'mcp__mem__memory__search' }))
      .toBe('MCP:mem/memory__search');
  });

  it('段数不足（仅 mcp__x）走 rest 兜底', () => {
    expect(resolveMcpToolNameStrategy({ ...base, toolName: '', currentName: 'mcp__solo' })).toBe('MCP:solo');
  });

  it('仅 mcp__（rest 为空）兜底为 MCP:unknown', () => {
    expect(resolveMcpToolNameStrategy({ ...base, toolName: '', currentName: 'mcp__' })).toBe('MCP:unknown');
  });

  it('非 mcp 前缀返回 undefined', () => {
    expect(resolveMcpToolNameStrategy({ ...base, toolName: '', currentName: 'Read' })).toBeUndefined();
  });
});

describe('resolveSkillToolNameStrategy', () => {
  it('Skill:xxx → 技能：xxx', () => {
    expect(resolveSkillToolNameStrategy({ ...base, toolName: '', currentName: 'Skill:commit' })).toBe('技能：commit');
  });

  it('裸 Skill + 带 skill 字段的 input → 技能：<skill>', () => {
    expect(resolveSkillToolNameStrategy({ ...base, toolInput: '{"skill":"docx"}', toolName: '', currentName: 'Skill' }))
      .toBe('技能：docx');
  });

  it('裸 Skill 无 input → 技能', () => {
    expect(resolveSkillToolNameStrategy({ ...base, toolInput: '', toolName: '', currentName: 'Skill' })).toBe('技能');
  });

  it('裸 Skill + skill 字段为空白 → 技能：未知', () => {
    expect(resolveSkillToolNameStrategy({ ...base, toolInput: '{"skill":"   "}', toolName: '', currentName: 'Skill' }))
      .toBe('技能：未知');
  });

  it('裸 Skill + 非法 JSON → 技能（catch 分支）', () => {
    expect(resolveSkillToolNameStrategy({ ...base, toolInput: '{bad', toolName: '', currentName: 'Skill' })).toBe('技能');
  });

  it('已本地化（技能：/ 技能:）返回 undefined 不再改写', () => {
    expect(resolveSkillToolNameStrategy({ ...base, toolName: '', currentName: '技能：docx' })).toBeUndefined();
    expect(resolveSkillToolNameStrategy({ ...base, toolName: '', currentName: '技能:docx' })).toBeUndefined();
  });

  it('非 skill 工具返回 undefined', () => {
    expect(resolveSkillToolNameStrategy({ ...base, toolName: '', currentName: 'Bash' })).toBeUndefined();
  });
});

describe('composeToolNameResolver / resolveDisplayToolName', () => {
  it('组合 resolver 逐一应用策略，命中即更新 currentName', () => {
    expect(resolveDisplayToolName({ toolId: 'x', toolName: 'bash', toolInput: '' })).toBe('Bash');
    expect(resolveDisplayToolName({ toolId: 'x', toolName: 'mcp__cron__manage', toolInput: '' })).toBe('MCP:cron/manage');
    expect(resolveDisplayToolName({ toolId: 'x', toolName: 'Skill', toolInput: '{"skill":"pptx"}' })).toBe('技能：pptx');
  });

  it('所有策略都不命中时返回原始 toolName', () => {
    expect(resolveDisplayToolName({ toolId: 'x', toolName: 'CustomTool', toolInput: '' })).toBe('CustomTool');
  });

  it('自定义策略数组按顺序生效', () => {
    const resolver = composeToolNameResolver([
      ({ currentName }) => (currentName === 'a' ? 'b' : undefined),
      ({ currentName }) => (currentName === 'b' ? 'c' : undefined),
    ]);
    expect(resolver({ toolId: '', toolName: 'a', toolInput: '' })).toBe('c');
  });
});

describe('isSkillTool', () => {
  it('识别协议与展示两种 skill 形态', () => {
    expect(isSkillTool('Skill')).toBe(true);
    expect(isSkillTool('技能')).toBe(true);
    expect(isSkillTool('Skill:commit')).toBe(true);
    expect(isSkillTool('技能：docx')).toBe(true);
    expect(isSkillTool('技能:docx')).toBe(true);
  });

  it('非 skill 与 undefined 返回 false', () => {
    expect(isSkillTool('Bash')).toBe(false);
    expect(isSkillTool(undefined)).toBe(false);
  });
});

describe('extractToolDescription', () => {
  it('提取并 trim description', () => {
    expect(extractToolDescription('{"description":"  跑测试  "}')).toBe('跑测试');
  });

  it('description 为空白 → undefined', () => {
    expect(extractToolDescription('{"description":"   "}')).toBeUndefined();
  });

  it('无 description 字段 → undefined', () => {
    expect(extractToolDescription('{"other":1}')).toBeUndefined();
  });

  it('空输入 / 半截 JSON → undefined（流式安全）', () => {
    expect(extractToolDescription('')).toBeUndefined();
    expect(extractToolDescription('{"descrip')).toBeUndefined();
  });
});

describe('getToolDisplayInfo', () => {
  it('有 description 时优先返回 description，截断方向 end', () => {
    expect(getToolDisplayInfo('Bash', '{"description":"列出文件","command":"ls"}'))
      .toEqual({ name: 'Bash', detail: '列出文件', detailTruncate: 'end' });
  });

  it('Read/Write/Edit 无 description 时取 file_path，截断方向 start', () => {
    expect(getToolDisplayInfo('Read', '{"file_path":"/a/b/c.ts"}'))
      .toEqual({ name: 'Read', detail: '/a/b/c.ts', detailTruncate: 'start' });
  });

  it('Grep/Glob 无 description 时取 pattern，截断方向 end', () => {
    expect(getToolDisplayInfo('Grep', '{"pattern":"foo.*bar"}'))
      .toEqual({ name: 'Grep', detail: 'foo.*bar', detailTruncate: 'end' });
  });

  it('无可用 detail（半截 JSON）时仅返回 name，默认截断 end', () => {
    expect(getToolDisplayInfo('Read', '{"file_pa'))
      .toEqual({ name: 'Read', detailTruncate: 'end' });
  });

  it('非 file/pattern 工具且无 description 时无 detail', () => {
    expect(getToolDisplayInfo('SomeTool', '{"x":1}'))
      .toEqual({ name: 'SomeTool', detailTruncate: 'end' });
  });
});

describe('getToolDisplayLabel', () => {
  it('有 detail 拼接 "Name: detail"', () => {
    expect(getToolDisplayLabel('Read', '{"file_path":"a.ts"}')).toBe('Read: a.ts');
  });

  it('无 detail 仅返回 Name', () => {
    expect(getToolDisplayLabel('Read', '{bad')).toBe('Read');
  });
});

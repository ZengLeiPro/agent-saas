/**
 * 工具摘要产出方的覆盖率闸门。
 *
 * 存在理由：`[CITE]` 引用溯源卡（shared/src/lib/markers.ts）有解析器、有组件、
 * 有 30 处测试，却因为**没有任何产出方**而零使用四个月。那次缺的不是代码，
 * 是一道会失败的闸门。本文件就是那道闸门。
 *
 * 规则：让一个工具真正做到 covered 后，把 PRESENTATION_TODO_BUDGET 减一。
 * 调高该常量必须在 PR 里显式说明理由——只减不增。
 */
import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_SOURCES,
  PRESENTATION_TODO_BUDGET,
  buildToolPresentation,
  listPresentationRuleNames,
  listMetadataRuleNames,
} from './toolPresentationBuilder.js';

describe('产出方登记表', () => {
  it('登记表与规则表互相覆盖：有规则必登记，登记为非 none 必有规则', () => {
    const rules = new Set(listPresentationRuleNames());
    const registered = new Map(PRESENTATION_SOURCES.map((entry) => [entry.tool, entry]));

    for (const rule of rules) {
      expect(registered.has(rule), `规则 ${rule} 未登记到 PRESENTATION_SOURCES`).toBe(true);
    }
    for (const [tool, entry] of registered) {
      if (entry.state !== 'none') {
        expect(rules.has(tool), `${tool} 登记为 ${entry.state} 但没有规则`).toBe(true);
      }
    }
  });

  it('state 非 covered 时必须写明 gap', () => {
    for (const entry of PRESENTATION_SOURCES) {
      if (entry.state === 'covered') continue;
      expect(entry.gap?.trim().length ?? 0, `${entry.tool} 缺 gap 说明`).toBeGreaterThan(0);
    }
  });

  it('登记表无重复条目', () => {
    const names = PRESENTATION_SOURCES.map((entry) => entry.tool);
    expect(new Set(names).size).toBe(names.length);
  });

  it('未覆盖工具数不得超过预算（只减不增的棘轮）', () => {
    const pending = PRESENTATION_SOURCES.filter((entry) => entry.state !== 'covered');
    expect(
      pending.length,
      `未覆盖 ${pending.length} 个（${pending.map((e) => e.tool).join(', ')}），预算 ${PRESENTATION_TODO_BUDGET}。`
      + '让一个工具做到 covered 后请把 PRESENTATION_TODO_BUDGET 减一；调高需 PR 显式说明。',
    ).toBeLessThanOrEqual(PRESENTATION_TODO_BUDGET);
  });
});

describe('截断前 metadata 规则', () => {
  it('covered 的工具都有 metadata 规则——covered 的定义就是「用了截断前的真实数据」', () => {
    const metadataRules = new Set(listMetadataRuleNames());
    for (const entry of PRESENTATION_SOURCES) {
      if (entry.state !== 'covered') continue;
      expect(metadataRules.has(entry.tool), `${entry.tool} 标为 covered 但没有 metadata 规则`).toBe(true);
    }
  });

  it('Shell 用退出码/字节数/耗时，全部来自截断前', () => {
    const result = buildToolPresentation(
      'Shell',
      { command: 'rg -n foo /w', description: '检索关键词' },
      undefined,
      { exitCode: 0, stdoutBytes: 12_698, stderrBytes: 0, durationMs: 3210 },
    );
    expect(result?.title).toBe('检索关键词');
    expect(result?.detail).toEqual([
      { k: '命令', v: 'rg -n foo /w' },
      { tree: '├', k: '退出码', v: '0' },
      { tree: '├', k: '输出', v: '12.4 KB' },
      { tree: '└', k: '耗时', v: '3.2 s' },
    ]);
    expect(result?.status).toBe('ok');
  });

  it('Shell 非零退出码标记为 warn', () => {
    const result = buildToolPresentation('Shell', { command: 'false' }, undefined, { exitCode: 1, durationMs: 12 });
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContainEqual({ tree: '├', k: '退出码', v: '1' });
  });

  it('Shell 截断/超时/中止各自留下明确痕迹，不静默', () => {
    const truncated = buildToolPresentation('Shell', { command: 'x' }, undefined, { exitCode: 0, outputExceeded: true });
    expect(truncated?.detail).toContainEqual({ indent: 0, text: '⚠ 输出超出捕获上限，已截断' });

    const timedOut = buildToolPresentation('Shell', { command: 'x' }, undefined, { timedOut: true });
    expect(timedOut?.status).toBe('warn');
    expect(timedOut?.detail).toContainEqual({ indent: 0, text: '⚠ 执行超时' });

    const aborted = buildToolPresentation('Shell', { command: 'x' }, undefined, { aborted: true });
    expect(aborted?.status).toBe('warn');
  });

  it('Shell 无 metadata 时退回入参侧规则，不编造统计', () => {
    const result = buildToolPresentation('Shell', { command: 'ls', description: '看一眼' });
    expect(result?.title).toBe('看一眼');
    expect(result?.detail).toEqual([{ k: '命令', v: 'ls' }]);
  });

  it('Write 用实际写入字节数，且优先用 metadata 里的真实落盘路径', () => {
    const result = buildToolPresentation(
      'Write',
      { file_path: '相对/路径.md' },
      undefined,
      { path: 'workspace/最终/路径.md', bytesWritten: 2458 },
    );
    expect(result?.title).toBe('写入 路径.md');
    expect(result?.detail).toEqual([
      { k: '路径', v: 'workspace/最终/路径.md' },
      { tree: '└', k: '写入', v: '2.4 KB' },
    ]);
  });

  it('Read 区分「请求范围」与「实读行数」——两者不一致本身就是信息', () => {
    const result = buildToolPresentation(
      'Read',
      { path: '制度/差旅.md', offset: 120, limit: 60 },
      undefined,
      { path: '制度/差旅.md', fileBytes: 18_600, linesRead: 41, ranged: true },
    );
    expect(result?.detail).toContainEqual({ tree: '├', k: '请求范围', v: '第 120–180 行' });
    expect(result?.detail).toContainEqual({ tree: '├', k: '实读', v: '41 行' });
    expect(result?.status).toBe('ok');
  });

  it('Read 截断时标 warn 并写明只返回了多少', () => {
    const result = buildToolPresentation(
      'Read',
      { path: 'big.log' },
      undefined,
      { path: 'big.log', fileBytes: 5_000_000, linesRead: 900, truncated: true, shownBytes: 131_072 },
    );
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContainEqual({ indent: 0, text: '⚠ 超出单次读取上限，仅返回前 128.0 KB' });
  });

  it('Edit 写出实际替换处数；命中数与替换数不一致时两个都写', () => {
    const partial = buildToolPresentation(
      'Edit',
      { file_path: 'a.ts' },
      undefined,
      { path: 'a.ts', replacements: 1, occurrences: 7, bytesBefore: 1000, bytesAfter: 1128 },
    );
    expect(partial?.detail).toContainEqual({ tree: '├', k: '替换', v: '1 处（命中 7 处）' });
    expect(partial?.detail).toContainEqual({ tree: '└', k: '体积变化', v: '+128 B' });

    const all = buildToolPresentation(
      'Edit',
      { file_path: 'a.ts', replace_all: true },
      undefined,
      { path: 'a.ts', replacements: 7, occurrences: 7, bytesBefore: 1000, bytesAfter: 900 },
    );
    expect(all?.detail).toContainEqual({ tree: '├', k: '替换', v: '7 处' });
    expect(all?.detail).toContainEqual({ tree: '└', k: '体积变化', v: '−100 B' });
  });

  it('字节与耗时的量级格式正确', () => {
    const big = buildToolPresentation('Shell', { command: 'x' }, undefined, { exitCode: 0, stdoutBytes: 3_500_000, durationMs: 125_000 });
    expect(big?.detail).toContainEqual({ tree: '├', k: '输出', v: '3.3 MB' });
    expect(big?.detail).toContainEqual({ tree: '└', k: '耗时', v: '2 分 5 秒' });

    const small = buildToolPresentation('Shell', { command: 'x' }, undefined, { exitCode: 0, stdoutBytes: 512, durationMs: 40 });
    expect(small?.detail).toContainEqual({ tree: '├', k: '输出', v: '512 B' });
    expect(small?.detail).toContainEqual({ tree: '└', k: '耗时', v: '40 ms' });
  });
});

describe('buildToolPresentation', () => {
  it('Read 用入参侧信息产出摘要', () => {
    const result = buildToolPresentation('Read', JSON.stringify({ file_path: '/w/制度/差旅.md' }));
    expect(result?.title).toBe('读取 差旅.md');
    expect(result?.detail).toEqual([{ k: '路径', v: '/w/制度/差旅.md' }]);
  });

  it('Read 带 offset/limit 时补范围行', () => {
    const result = buildToolPresentation('Read', { file_path: '/w/a.md', offset: 120, limit: 60 });
    expect(result?.detail).toContainEqual({ tree: '└', k: '范围', v: '第 120–180 行' });
  });

  it('Shell 优先用 description 作标题——它是模型对本次执行的意图说明', () => {
    const result = buildToolPresentation('Shell', { command: 'rg -n foo /w', description: '检索合同关键词' });
    expect(result?.title).toBe('检索合同关键词');
    expect(result?.detail).toEqual([{ k: '命令', v: 'rg -n foo /w' }]);
  });

  it('Shell 无 description 时退回通用标题，不编造意图', () => {
    expect(buildToolPresentation('Shell', { command: 'ls' })?.title).toBe('执行命令');
  });

  it('超长命令截断，避免单行撑爆摘要', () => {
    const result = buildToolPresentation('Shell', { command: 'x'.repeat(400) });
    const line = result?.detail?.[0] as { k: string; v: string };
    expect(line.v.length).toBeLessThanOrEqual(121);
    expect(line.v.endsWith('…')).toBe(true);
  });

  it('未登记规则的工具返回 undefined，渲染优雅退化', () => {
    expect(buildToolPresentation('SomeUnknownTool', { a: 1 })).toBeUndefined();
  });

  it('入参缺关键字段时返回 undefined，不产出半截摘要', () => {
    expect(buildToolPresentation('Read', {})).toBeUndefined();
    expect(buildToolPresentation('Shell', {})).toBeUndefined();
  });

  it('入参不是合法 JSON 时不抛错', () => {
    expect(() => buildToolPresentation('Read', '{ 坏 JSON')).not.toThrow();
    expect(buildToolPresentation('Read', '{ 坏 JSON')).toBeUndefined();
  });

  it('provider 已自产的摘要不被规则覆盖——它拿得到截断前的原始数据', () => {
    const own = { title: '读取 差旅.md（1,204 行，已截断）' };
    expect(buildToolPresentation('Read', { file_path: '/w/差旅.md' }, own)).toBe(own);
  });
});

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
  buildFailurePresentation,
  extractToolResultMetadata,
  ToolExecutionError,
} from './toolPresentationBuilder.js';

describe('产出方登记表', () => {
  it('登记表与规则表互相覆盖：有规则必登记，登记为非 none 必有规则', () => {
    const rules = new Set(listPresentationRuleNames());
    const registered = new Map(PRESENTATION_SOURCES.map((entry) => [entry.tool, entry]));

    for (const rule of rules) {
      expect(registered.has(rule), `规则 ${rule} 未登记到 PRESENTATION_SOURCES`).toBe(true);
    }
    for (const [tool, entry] of registered) {
      // mapping 层产出的工具（如 Agent）不在本模块规则表内，是显式例外
      if (entry.state !== 'none' && entry.producedIn !== 'mapping') {
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
      if (entry.state !== 'covered' || entry.producedIn === 'mapping') continue;
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
    expect(truncated?.detail).toContainEqual({ warn: '输出超出捕获上限，已截断' });

    const timedOut = buildToolPresentation('Shell', { command: 'x' }, undefined, { timedOut: true });
    expect(timedOut?.status).toBe('warn');
    expect(timedOut?.detail).toContainEqual({ warn: '执行超时' });

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
    expect(result?.detail).toContainEqual({ warn: '超出单次读取上限，仅返回前 128.0 KB' });
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

describe('连接器动作还原成业务语言', () => {
  it('dws 命令识别出系统与模块，标题不再是一行 shell', () => {
    const result = buildToolPresentation('Shell', { command: 'dws todo create --title 复核合同' });
    expect(result?.title).toBe('钉钉 · 待办 · create');
    expect(result?.detail?.[0]).toEqual({ k: '系统', v: '钉钉' });
  });

  it('模型给了 description 时仍以业务意图为准，系统行照样保留', () => {
    const result = buildToolPresentation(
      'Shell',
      { command: 'lark im send --chat x', description: '把结论发到项目群' },
      undefined,
      { exitCode: 0, durationMs: 220 },
    );
    expect(result?.title).toBe('把结论发到项目群');
    expect(result?.detail?.[0]).toEqual({ k: '系统', v: '飞书' });
  });

  it('普通命令不被误判成连接器', () => {
    const result = buildToolPresentation('Shell', { command: 'rg -n foo /w' });
    expect(result?.title).toBe('执行命令');
    expect(result?.detail?.[0]).toEqual({ k: '命令', v: 'rg -n foo /w' });
  });

  it('MCP 工具显示「系统 · 动作」与关键入参，而不是 mcp__server__tool', () => {
    const result = buildToolPresentation('mcp__dingtalk__create_todo', {
      title: '复核出口证据',
      dueDate: '2026-07-28',
    });
    expect(result?.title).toBe('钉钉 · create_todo');
    expect(result?.detail).toContainEqual({ k: '动作', v: 'create_todo' });
    expect(result?.detail).toContainEqual({ tree: '└', k: 'dueDate', v: '2026-07-28' });
  });

  it('未登记的 MCP server 用原名，不硬凑中文', () => {
    expect(buildToolPresentation('mcp__acme__do_thing', {})?.title).toBe('acme · do_thing');
  });

  it('形如 MCP 但结构不完整时不产出摘要', () => {
    expect(buildToolPresentation('mcp__onlyserver', {})).toBeUndefined();
  });
});

describe('结构化事实（tool_result.metadata）', () => {
  it('Shell 落退出码/信号/耗时/字节数——原值进事件，不再只以「Exit code: N」文本行存活', () => {
    expect(extractToolResultMetadata('Shell', {
      exitCode: 1,
      signal: 'SIGTERM',
      durationMs: 3210,
      stdoutBytes: 12_698,
      stderrBytes: 40,
      timedOut: false,
      aborted: false,
      outputExceeded: true,
    })).toEqual({
      exitCode: 1,
      signal: 'SIGTERM',
      durationMs: 3210,
      stdoutBytes: 12_698,
      stderrBytes: 40,
      timedOut: false,
      aborted: false,
      outputExceeded: true,
    });
  });

  it('只收白名单键：路由信息、outputFiles 之类的内部细节不进 durable 事件', () => {
    expect(extractToolResultMetadata('Shell', {
      exitCode: 0,
      handId: 'hand-9',
      outputFiles: [{ path: 'tmp/x.txt' }],
      workspaceId: 'w-1',
    })).toEqual({ exitCode: 0 });
  });

  it('文件类工具落关键字段（行数/字节数/替换处数）', () => {
    expect(extractToolResultMetadata('Read', { path: '/w/a.md', linesRead: 41, fileBytes: 18_600, truncated: false }))
      .toEqual({ linesRead: 41, fileBytes: 18_600, truncated: false });
    expect(extractToolResultMetadata('Write', { path: '/w/a.md', bytesWritten: 2458 }))
      .toEqual({ bytesWritten: 2458 });
    expect(extractToolResultMetadata('Edit', { path: '/w/a.ts', replacements: 1, occurrences: 7, bytesBefore: 1000, bytesAfter: 1128 }))
      .toEqual({ replacements: 1, occurrences: 7, bytesBefore: 1000, bytesAfter: 1128 });
  });

  it('未登记的工具、空 metadata、全部字段落空时返回 undefined——宁可没有，不可编造', () => {
    expect(extractToolResultMetadata('TodoWrite', { anything: 1 })).toBeUndefined();
    expect(extractToolResultMetadata('Shell', undefined)).toBeUndefined();
    expect(extractToolResultMetadata('Shell', { handId: 'h' })).toBeUndefined();
  });

  it('非有限数字与超长字符串被丢弃', () => {
    expect(extractToolResultMetadata('Shell', { exitCode: 0, durationMs: Number.NaN, signal: 'x'.repeat(200) }))
      .toEqual({ exitCode: 0 });
  });
});

describe('失败态摘要', () => {
  it('错误自带摘要时原样保留——那是 provider 按真实 metadata 产出的', () => {
    const carried = { title: '执行命令', detail: [{ k: '退出码', v: '127' }], status: 'warn' as const };
    const result = buildFailurePresentation('Shell', { command: 'nope' }, new ToolExecutionError('command not found', carried));
    expect(result).toEqual(carried);
  });

  it('错误自带摘要但没写 status 时补 warn——失败绝不能显示为 ok', () => {
    const result = buildFailurePresentation('Shell', {}, new ToolExecutionError('boom', { title: '执行命令' }));
    expect(result?.status).toBe('warn');
  });

  it('普通错误退回入参侧规则，并强制标 warn', () => {
    const result = buildFailurePresentation('Read', { file_path: '/w/缺失.md' }, new Error('ENOENT'));
    expect(result?.title).toBe('读取 缺失.md');
    expect(result?.status).toBe('warn');
  });

  it('无规则的工具失败时不产出摘要，退化为原有占位', () => {
    expect(buildFailurePresentation('未知工具', {}, new Error('x'))).toBeUndefined();
  });

  it('入参也解析不出时不硬凑摘要', () => {
    expect(buildFailurePresentation('Read', {}, new Error('x'))).toBeUndefined();
  });

  it('ToolExecutionError 不带摘要时同样退回入参侧规则', () => {
    const result = buildFailurePresentation('Shell', { command: 'ls', description: '看一眼' }, new ToolExecutionError('failed'));
    expect(result?.title).toBe('看一眼');
    expect(result?.status).toBe('warn');
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

describe('联网与生图', () => {
  it('WebSearch 写出来源与命中条数', () => {
    const result = buildToolPresentation(
      'WebSearch',
      { query: '差旅标准' },
      undefined,
      { query: '差旅标准', provider: 'bing', resultCount: 8, truncated: false },
    );
    expect(result?.title).toBe('联网检索');
    expect(result?.detail).toEqual([
      { k: '检索词', v: '差旅标准' },
      { tree: '├', k: '来源', v: 'bing' },
      { tree: '└', k: '命中', v: '8 条' },
    ]);
  });

  it('WebFetch 在发生跳转时把原始地址也写出来——落到哪个域名是安全事实', () => {
    const result = buildToolPresentation(
      'WebFetch',
      { url: 'http://a.example/x' },
      undefined,
      {
        url: 'http://a.example/x',
        finalUrl: 'https://b.example/y',
        status: 200,
        rawLength: 42_000,
        returnedLength: 12_000,
        truncated: true,
        tookMs: 1840,
      },
    );
    expect(result?.detail?.[0]).toEqual({ k: '来源', v: 'https://b.example/y' });
    expect(result?.detail).toContainEqual({ tree: '├', k: '原始地址', v: 'http://a.example/x' });
    expect(result?.detail).toContainEqual({ tree: '├', k: '正文', v: '12,000 字（原文 42,000 字）' });
    expect(result?.status).toBe('warn');
  });

  it('WebFetch 未跳转时不画蛇添足写原始地址', () => {
    const result = buildToolPresentation(
      'WebFetch',
      { url: 'https://a.example/x' },
      undefined,
      { url: 'https://a.example/x', finalUrl: 'https://a.example/x', status: 200 },
    );
    expect(result?.detail?.some((line) => typeof line === 'object' && 'k' in line && line.k === '原始地址')).toBe(false);
  });

  it('GenerateImage 把扣费写进摘要——这是客户最该看见的一行', () => {
    const result = buildToolPresentation(
      'GenerateImage',
      { prompt: '一只蓝白英短' },
      undefined,
      { engine: 'seedream', size: '1024x1024', count: 2, creditsCharged: 40, pricingNote: '20 积分/张' },
    );
    expect(result?.detail).toContainEqual({ tree: '└', k: '积分', v: '40（20 积分/张）' });
    expect(result?.detail).toContainEqual({ k: '画面', v: '一只蓝白英短' });
  });

  it('GenerateImage 未计费租户显示计费说明而非编造 0 积分', () => {
    const result = buildToolPresentation(
      'GenerateImage',
      { prompt: 'x' },
      undefined,
      { engine: 'gpt-image-2', size: '512x512', count: 1, billingNote: '该组织未启用积分计费' },
    );
    expect(result?.detail).toContainEqual({ tree: '└', k: '计费', v: '该组织未启用积分计费' });
    expect(result?.detail?.some((line) => typeof line === 'object' && 'k' in line && line.k === '积分')).toBe(false);
  });
});

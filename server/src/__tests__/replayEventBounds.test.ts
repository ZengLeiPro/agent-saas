import { describe, expect, it } from 'vitest';

import {
  boundReplayToolResultEvents,
  buildToolResultProjectionSource,
  MODEL_TOOL_RESULT_MAX_CHARS,
  projectToolResultContentForModel,
  projectToolResultSourceForModel,
} from '../runtime/replayEventBounds.js';
import type { PlatformEvent } from '../runtime/types.js';

function toolResult(
  index: number,
  content: string,
): Extract<PlatformEvent, { type: 'tool_result' }> {
  return {
    id: `event-${index}`,
    timestamp: new Date(index).toISOString(),
    type: 'tool_result',
    runId: 'run-1',
    sessionId: 'session-1',
    toolCallId: `call-${index}`,
    toolName: 'Shell',
    content,
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

describe('bounded replay event view', () => {
  it('多行结果保留完整头尾行，并给出精确行区间与两种回查入口', () => {
    const content = Array.from(
      { length: 1_200 },
      (_, index) => `line-${String(index + 1).padStart(4, '0')}:${'x'.repeat(24)}`,
    ).join('\n');

    const projected = projectToolResultContentForModel(content, 'call-lines');

    expect(codePointLength(projected)).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARS);
    expect(projected).toContain('line-0001:');
    expect(projected).toContain('line-1200:');
    expect(projected).toMatch(/保留 1-\d+、\d+-1200 行；省略 \d+-\d+ 行/);
    expect(projected).toMatch(/startLine=\d+, lineCount=200/);
    expect(projected).toContain('query="关键字"');
  });

  it('超长单行结果按 Unicode 字符保留首尾，并给出字符区间回查入口', () => {
    const content = `${'头'.repeat(10_000)}${'🙂'.repeat(10_000)}尾部签名`;

    const projected = projectToolResultContentForModel(content, 'call-single-line');

    expect(codePointLength(projected)).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARS);
    expect(projected.startsWith('头'.repeat(100))).toBe(true);
    expect(projected.endsWith('尾部签名')).toBe(true);
    expect(projected).toMatch(/保留字符 1-2000、\d+-20004；省略 2001-\d+/);
    expect(projected).toContain('startChar=2001, charCount=6000');
    expect(projected).toContain('query="关键字"');
  });

  it('PG 有界首尾源与完整原文生成完全相同的模型投影', () => {
    const content = Array.from(
      { length: 900 },
      (_, index) => `第${index + 1}行🙂:${'值'.repeat(20)}`,
    ).join('\n');
    const source = buildToolResultProjectionSource(content);

    expect(projectToolResultSourceForModel(source, 'call-pg'))
      .toBe(projectToolResultContentForModel(content, 'call-pg'));
    expect(source.totalChars).toBe(codePointLength(content));
    expect(source.totalLines).toBe(900);
  });

  it('追加事件不会改变既有投影，durable 原文不被修改', () => {
    const content = Array.from({ length: 600 }, (_, index) => `line-${index + 1}:${'x'.repeat(30)}`).join('\n');
    const first = toolResult(0, content);
    const initial = boundReplayToolResultEvents([first]);
    const extended = boundReplayToolResultEvents([
      first,
      ...Array.from({ length: 20 }, (_, index) => toolResult(index + 1, `${'y'.repeat(20_000)}-${index}`)),
    ]);

    expect(extended[0]).toEqual(initial[0]);
    expect(first.content).toBe(content);
    expect(first.content).toHaveLength(content.length);
  });

  it('兼容旧 modelContent 字段，但不再把它带入 replay 或覆盖新投影', () => {
    const content = 'x'.repeat(20_000);
    const legacy = {
      ...toolResult(0, content),
      modelContent: '旧的、不可复用的投影',
    } as Extract<PlatformEvent, { type: 'tool_result' }> & { modelContent: string };

    const [bounded] = boundReplayToolResultEvents([legacy]);

    expect(bounded).not.toHaveProperty('modelContent');
    expect(bounded?.type === 'tool_result' ? bounded.content : '')
      .toBe(projectToolResultContentForModel(content, 'call-0'));
  });
});

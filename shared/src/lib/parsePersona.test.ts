/**
 * parsePersona.ts 测试
 *
 * 校验 header（标题 # / 引用 > / 空行）与正文的切分逻辑：
 * - 引用行去掉 `>` 前缀后进入 hints
 * - 遇到第一行非 header 内容即停止，其余全部作为 body
 * - 空内容 / 纯 header / 纯 body 等边界
 */
import { describe, expect, it } from 'vitest';
import { parsePersona } from './parsePersona';

describe('parsePersona', () => {
  it('分离标题+引用提示与正文', () => {
    const content = [
      '# 我的角色',
      '> 这是编辑提示第一行',
      '> 第二行提示',
      '',
      '你是一名资深销售助理。',
      '请始终使用中文回复。',
    ].join('\n');

    expect(parsePersona(content)).toEqual({
      hints: '这是编辑提示第一行\n第二行提示',
      body: '你是一名资深销售助理。\n请始终使用中文回复。',
    });
  });

  it('无引用行时 hints 为空，body 保留全部正文', () => {
    const content = '# 标题\n\n正文内容';
    expect(parsePersona(content)).toEqual({ hints: '', body: '正文内容' });
  });

  it('无 header 时 body 从首行开始，hints 为空', () => {
    const content = '直接就是正文\n第二行';
    expect(parsePersona(content)).toEqual({ hints: '', body: '直接就是正文\n第二行' });
  });

  it('遇到正文后即使后续再出现 # / > 也归入 body', () => {
    const content = '> 前置提示\n正文开始\n# 这行不再是提示\n> 这行也不是';
    const result = parsePersona(content);
    expect(result.hints).toBe('前置提示');
    expect(result.body).toBe('正文开始\n# 这行不再是提示\n> 这行也不是');
  });

  it('空字符串返回空 hints 与空 body', () => {
    expect(parsePersona('')).toEqual({ hints: '', body: '' });
  });

  it('全部是 header（无正文）时 body 为空', () => {
    expect(parsePersona('# 标题\n> 提示\n\n')).toEqual({ hints: '提示', body: '' });
  });

  it('引用前缀后的内容会被 trim', () => {
    expect(parsePersona('>    有空格的提示   ').hints).toBe('有空格的提示');
  });
});

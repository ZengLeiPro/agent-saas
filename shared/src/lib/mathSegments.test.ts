import { describe, expect, it } from 'vitest';

import { hasMathSegments, splitMathSegments } from './mathSegments';

describe('splitMathSegments 块级', () => {
  it('无公式时返回单个文本段', () => {
    expect(splitMathSegments('普通文本')).toEqual([{ type: 'text', content: '普通文本' }]);
    expect(hasMathSegments(splitMathSegments('普通文本'))).toBe(false);
  });

  it('切出 $$…$$ 与 \\[…\\]', () => {
    expect(splitMathSegments('前 $$a^2$$ 后')).toEqual([
      { type: 'text', content: '前 ' },
      { type: 'math', tex: 'a^2', display: true },
      { type: 'text', content: ' 后' },
    ]);
    expect(splitMathSegments('\\[E=mc^2\\]')).toEqual([
      { type: 'math', tex: 'E=mc^2', display: true },
    ]);
  });

  it('公式两侧空白被裁掉，空公式不产出 math 段', () => {
    expect(splitMathSegments('$$\n  x + y \n$$')).toEqual([
      { type: 'math', tex: 'x + y', display: true },
    ]);
    expect(splitMathSegments('$$   $$')).toEqual([{ type: 'text', content: '$$   $$' }]);
  });

  it('未闭合分隔符原样保留为文本（流式半截公式不闪烁）', () => {
    expect(splitMathSegments('正在输出 $$a^2')).toEqual([
      { type: 'text', content: '正在输出 $$a^2' },
    ]);
  });

  it('默认不切行内公式', () => {
    expect(splitMathSegments('单价 $5$ 元')).toEqual([{ type: 'text', content: '单价 $5$ 元' }]);
  });

  it('多段公式按出现顺序交错', () => {
    const out = splitMathSegments('a$$x$$b$$y$$c');
    expect(out.map((s) => (s.type === 'math' ? `M:${s.tex}` : s.content))).toEqual([
      'a',
      'M:x',
      'b',
      'M:y',
      'c',
    ]);
  });
});

describe('splitMathSegments 代码保护', () => {
  it('围栏代码块内的 $$ 不当公式', () => {
    const text = '```sh\necho $$ && echo $$\n```\n后面';
    expect(splitMathSegments(text)).toEqual([{ type: 'text', content: text }]);
  });

  it('未闭合的围栏吃到结尾', () => {
    const text = '```\n$$a$$';
    expect(splitMathSegments(text)).toEqual([{ type: 'text', content: text }]);
  });

  it('围栏之后的公式正常切分', () => {
    const out = splitMathSegments('```\ncode\n```\n$$a$$');
    expect(out).toEqual([
      { type: 'text', content: '```\ncode\n```\n' },
      { type: 'math', tex: 'a', display: true },
    ]);
  });

  it('行内代码里的 $$ 不当公式', () => {
    expect(splitMathSegments('用 `$$PID` 取值')).toEqual([
      { type: 'text', content: '用 `$$PID` 取值' },
    ]);
  });

  it('未闭合的反引号不吞后续公式', () => {
    const out = splitMathSegments('` 未闭合 $$a$$');
    expect(out).toEqual([
      { type: 'text', content: '` 未闭合 ' },
      { type: 'math', tex: 'a', display: true },
    ]);
  });
});

describe('splitMathSegments 行内开关', () => {
  it('inline=true 时切出 $…$ 与 \\(…\\)', () => {
    expect(splitMathSegments('设 $x$ 与 \\(y\\)', { inline: true })).toEqual([
      { type: 'text', content: '设 ' },
      { type: 'math', tex: 'x', display: false },
      { type: 'text', content: ' 与 ' },
      { type: 'math', tex: 'y', display: false },
    ]);
  });

  it('inline=true 时块级仍优先于行内', () => {
    expect(splitMathSegments('$$a$$', { inline: true })).toEqual([
      { type: 'math', tex: 'a', display: true },
    ]);
  });
});

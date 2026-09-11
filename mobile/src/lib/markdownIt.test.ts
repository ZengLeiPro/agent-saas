import { describe, expect, it } from 'vitest';
import { cjkMarkdownIt } from './markdownIt';

describe('移动端 markdown-it CJK 解析', () => {
  it('支持标点后的 emphasis 与 strikethrough 闭合符直接连接正文', () => {
    const html = cjkMarkdownIt.renderInline('**结论：**正文；*提示。*后文；~~废弃：~~正文');

    expect(html).toContain('<strong>结论：</strong>正文');
    expect(html).toContain('<em>提示。</em>后文');
    expect(html).toContain('<s>废弃：</s>正文');
  });

  it('不改写代码与转义的 Markdown 原文', () => {
    const html = cjkMarkdownIt.renderInline('`**代码：**正文` 和 \\**普通文本：**正文');

    expect(html).toContain('<code>**代码：**正文</code>');
    expect(html).not.toContain('<strong>普通文本：</strong>');
  });

  it('升级后仍保留链接、列表、代码块和排版能力', () => {
    const html = cjkMarkdownIt.render(
      [
        '"中文引号"',
        '',
        '[开沿](https://kaiyan.net)',
        '',
        '- 第一项',
        '- 第二项',
        '',
        '```ts',
        'const ok = true;',
        '```',
      ].join('\n'),
    );

    expect(html).toContain('“中文引号”');
    expect(html).toContain('<a href="https://kaiyan.net">开沿</a>');
    expect(html).toContain('<li>第一项</li>');
    expect(html).toContain('<li>第二项</li>');
    expect(html).toContain('<code class="language-ts">const ok = true;');
  });
});

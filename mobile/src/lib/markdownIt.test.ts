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
});

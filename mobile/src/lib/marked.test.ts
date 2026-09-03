import { describe, expect, it } from 'vitest';
import { parseMarkdownToHtml } from './marked';

describe('移动端文字选择 Markdown CJK 解析', () => {
  it('支持标点后的粗体与斜体闭合符直接连接正文', () => {
    const html = parseMarkdownToHtml('**结论：**正文；*提示。*后文');

    expect(html).toContain('<strong>结论：</strong>正文');
    expect(html).toContain('<em>提示。</em>后文');
  });

  it('保留 GFM 删除线和代码语义', () => {
    const html = parseMarkdownToHtml('~~废弃：~~正文；`**代码：**正文`');

    expect(html).toContain('<del>废弃：</del>正文');
    expect(html).toContain('<code>**代码：**正文</code>');
  });
});

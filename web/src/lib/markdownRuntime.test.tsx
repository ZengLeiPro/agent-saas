import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loadMarkdownRuntime } from './markdownRuntime';

async function renderMarkdown(content: string) {
  const { Markdown, remarkPlugins, rehypePlugins } = await loadMarkdownRuntime();
  return render(
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
      {content}
    </Markdown>,
  );
}

describe('CJK Markdown 解析', () => {
  it('支持中文标点后的粗体闭合符直接连接正文', async () => {
    await renderMarkdown('**结论：**正文；前文。**重点。**后文');

    expect(screen.getByText('结论：').tagName).toBe('STRONG');
    expect(screen.getByText('重点。').tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('同步支持斜体与 GFM 删除线', async () => {
    await renderMarkdown('*提示：*正文；*注意。*后文；~~废弃：~~正文');

    expect(screen.getByText('提示：').tagName).toBe('EM');
    expect(screen.getByText('注意。').tagName).toBe('EM');
    expect(screen.getByText('废弃：').tagName).toBe('DEL');
  });

  it('不改写代码与转义的 Markdown 原文', async () => {
    await renderMarkdown('`**代码：**正文` 和 \\**普通文本：**正文');

    expect(screen.getByText('**代码：**正文').tagName).toBe('CODE');
    expect(screen.queryByText('普通文本：', { selector: 'strong' })).toBeNull();
  });
});

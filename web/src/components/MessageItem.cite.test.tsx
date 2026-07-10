/**
 * MessageItem CITE 渲染测试（计划用例 7-8）
 *
 * 7. streaming 半截 [CITE]{ 不显示原始标记；完成后渲染引用卡
 * 8. FILE+CITE 同消息双卡渲染 + 纯 FILE 行为回归
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import type { MessageItem as MessageItemType } from './types';

beforeAll(() => {
  // jsdom 未实现 Range.getClientRects（MessageItem footer 行内测量用）；
  // 返回空列表 → footer 走非行内分支，不影响本用例断言。
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

vi.mock('@/lib/authFetch', () => ({
  authFetch: vi.fn(async () => new Response(null, { status: 200 })),
  setOnUnauthorized: vi.fn(),
}));

function textMessage(content: string, streaming: boolean): MessageItemType {
  return { id: 'line-1', type: 'text', content, streaming };
}

function renderMessage(message: MessageItemType) {
  return render(
    <FilePreviewProvider value={{ openPreview: vi.fn() }}>
      <MessageItem message={message} index={0} />
    </FilePreviewProvider>,
  );
}

describe('MessageItem CITE 渲染', () => {
  it('用例7: streaming 半截 [CITE]{ 不显示，完成后渲染引用卡', () => {
    const { unmount } = renderMessage(textMessage('先看这份文档 [CITE]{"doc":"catalog/a.p', true));
    // 半截标记被裁掉：不出现 [CITE] 原始文本
    expect(document.body.textContent).not.toContain('[CITE]');
    expect(document.body.textContent).toContain('先看这份文档');
    unmount();

    renderMessage(textMessage('先看这份文档 [CITE]{"doc":"catalog/a.pdf","page":5,"label":"目录 p.5"}[/CITE] 完毕', false));
    // 完成后渲染 CitationCard
    expect(screen.getByRole('button', { name: '引用：目录 p.5' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('[CITE]');
  });

  it('用例8: FILE+CITE 同消息双卡 + 纯 FILE 回归', () => {
    const { unmount } = renderMessage(textMessage(
      '报告 [FILE]{"filePath":"assets/月报.pdf"}[/FILE] 依据 [CITE]{"doc":"kb/规格书.pdf","page":2}[/CITE] 完成',
      false,
    ));
    // FILE 卡（文件名）+ CITE 卡（label 缺省 = basename + p.N）同时渲染
    expect(screen.getByText('月报.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: '引用：规格书.pdf p.2' })).toBeTruthy();
    unmount();

    // 纯 FILE 回归（兼容性红线）：行为与既有一致——文件卡 + 下载按钮
    renderMessage(textMessage('产物 [FILE]{"filePath":"assets/output.xlsx"}[/FILE]', false));
    expect(screen.getByText('output.xlsx')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载 output.xlsx' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('[FILE]');
  });
});

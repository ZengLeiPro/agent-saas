// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('主会话排版契约', () => {
  it('消息、输入框与上传区共用 16–32px 自适应水平留白', () => {
    const start = css.indexOf('\n  .content-container {');
    const end = css.indexOf('\n  }', start);
    const definition = css.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(definition).toContain('@apply mx-auto max-w-3xl md:max-w-4xl;');
    expect(definition).toContain('padding-inline: clamp(1rem, 4%, 2rem);');
    expect(definition).not.toContain('px-3');
  });

  it('只在 MessageList 内容树内把三档字号整体升一级', () => {
    expect(css).toContain('.chat-font-large .chat-message-content .text-sm');
    expect(css).toContain('.chat-font-large .chat-message-content .text-xs');
    expect(css).toContain('.chat-font-large .chat-message-content .text-2xs');
    expect(css).not.toContain('.chat-font-large .text-sm');
  });

  it('原始代码预览在 Tailwind @apply 之后恢复为 12px/16px', () => {
    const definition = css.indexOf('\n  .code-preview {');
    const override = css.indexOf('\n  .chat-font-large .chat-message-content .code-preview {', definition);
    expect(definition).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(definition);
    expect(css.slice(override, override + 180)).toContain('font-size: 0.75rem');
    expect(css.slice(override, override + 180)).toContain('line-height: 1rem');
  });
});

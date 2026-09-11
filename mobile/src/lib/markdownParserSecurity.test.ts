import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function expectParserToFinish(source: string, timeout = 2_000): void {
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '--eval', source],
    {
      cwd: MOBILE_ROOT,
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
    },
  );

  expect({
    error: result.error?.message,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr,
  }).toEqual({ error: undefined, signal: null, status: 0, stderr: '' });
}

describe('移动端 Markdown 解析器资源耗尽回归', () => {
  it('Marked 在独立受限进程内完成历史三字节 OOM 输入', () => {
    expectParserToFinish(`
      import { Marked } from 'marked';
      import markedCjkFriendly from 'marked-cjk-friendly';

      new Marked(markedCjkFriendly()).parse('\\x09\\x0b\\n');
    `);
  });

  it('markdown-it 在独立受限进程内完成历史 newline ReDoS 输入', () => {
    expectParserToFinish(`
      import MarkdownIt from 'markdown-it';
      import markdownItCjkFriendly from 'markdown-it-cjk-friendly';

      new MarkdownIt({ typographer: true })
        .use(markdownItCjkFriendly)
        .render('x ' + ' '.repeat(150_000) + ' x  \\nx');
    `);
  });

  it('linkify-it 在独立受限进程内完成历史 mailto 二次复杂度输入', () => {
    expectParserToFinish(`
      import MarkdownIt from 'markdown-it';

      new MarkdownIt({ linkify: true }).render('mailto:'.repeat(48_000));
    `);
  });
});

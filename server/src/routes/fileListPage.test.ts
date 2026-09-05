import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../security/trustedFile.js', () => ({
  openTrustedDirectory: async (root: string, relativePath: string) => ({
    fdPath: join(root, relativePath),
    handle: { close: async () => {} },
  }),
}));

import {
  InvalidFileListCursorError,
  listRecursiveFilePage,
  parseRecursiveFilePageSize,
} from './fileListPage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'file-list-page-'));
  roots.push(root);
  await mkdir(join(root, 'docs', 'nested'), { recursive: true });
  await mkdir(join(root, '.hidden'), { recursive: true });
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, 'docs', 'b.txt'), 'b');
  await writeFile(join(root, 'docs', 'nested', 'c.txt'), 'c');
  await writeFile(join(root, 'z.txt'), 'z');
  await writeFile(join(root, '.hidden', 'secret.txt'), 'secret');
  return root;
}

describe('listRecursiveFilePage', () => {
  it('游标跨页延续深度优先遍历，不重扫成重复结果', async () => {
    const selectedRoot = await fixture();
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listRecursiveFilePage({
        selectedRoot,
        rootPath: 'assets',
        cursor,
        limit: 2,
      });
      paths.push(...page.entries.map((entry) => entry.path));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(paths).toEqual([
      'assets/a.txt',
      'assets/docs/b.txt',
      'assets/docs/nested/c.txt',
      'assets/z.txt',
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('游标绑定请求根目录，伪造越界路径会被拒绝', async () => {
    const selectedRoot = await fixture();
    const forged = Buffer.from(
      JSON.stringify({
        version: 1,
        rootPath: 'assets',
        stack: [{ directoryPath: 'assets/../memory', afterName: null }],
      }),
    ).toString('base64url');

    await expect(
      listRecursiveFilePage({
        selectedRoot,
        rootPath: 'assets',
        cursor: forged,
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(InvalidFileListCursorError);
  });
});

describe('parseRecursiveFilePageSize', () => {
  it('只接受 1..500 的十进制整数', () => {
    expect(parseRecursiveFilePageSize(undefined)).toBe(200);
    expect(parseRecursiveFilePageSize('1')).toBe(1);
    expect(parseRecursiveFilePageSize('500')).toBe(500);
    expect(() => parseRecursiveFilePageSize('0')).toThrow(InvalidFileListCursorError);
    expect(() => parseRecursiveFilePageSize('501')).toThrow(InvalidFileListCursorError);
    expect(() => parseRecursiveFilePageSize('1.5')).toThrow(InvalidFileListCursorError);
  });
});

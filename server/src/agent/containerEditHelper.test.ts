import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTAINER_FILE_HELPER_SCRIPT } from './containerExecutionProvider.js';

type HelperResult = {
  ok?: boolean;
  content?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

function runHelper(root: string, request: Record<string, unknown>): HelperResult {
  const output = execFileSync(process.execPath, ['-e', CONTAINER_FILE_HELPER_SCRIPT], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: { ...process.env, KY_AGENT_WORKDIR: root },
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output) as HelperResult;
}

describe('container Edit helper', () => {
  it('脚本可执行，并在 fuzzy 匹配后还原 BOM 与 CRLF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-edit-helper-'));
    const path = join(root, 'a.txt');
    await writeFile(path, '\uFEFFone “two”  \r\nthree\r\n', 'utf8');

    const result = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      edits: [
        {
          old_string: 'one "two"\nthree',
          new_string: 'ONE "TWO"\nthree',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      replacements: 1,
      editCount: 1,
      fuzzyMatches: 1,
      bomPreserved: true,
      lineEnding: 'CRLF',
    });
    expect(await readFile(path, 'utf8')).toBe('\uFEFFONE "TWO"\r\nthree\r\n');
  });

  it('保留目标外混合行尾，并支持组合字符 NFKC 与 BOM-in-old/new', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-edit-helper-'));
    const path = join(root, 'a.txt');
    await writeFile(path, '\uFEFFa\r\ncafe\u0301\nc\r\n', 'utf8');

    const fuzzy = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      old_string: 'café',
      new_string: 'coffee',
    });
    expect(fuzzy).toMatchObject({ ok: true, metadata: { fuzzyMatches: 1 } });
    expect(await readFile(path, 'utf8')).toBe('\uFEFFa\r\ncoffee\nc\r\n');

    await writeFile(path, 'oﬃce', 'utf8');
    const partialLigature = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      old_string: 'fi',
      new_string: 'X',
    });
    expect(partialLigature).toMatchObject({ ok: false });
    expect(await readFile(path, 'utf8')).toBe('oﬃce');

    await writeFile(path, '\uFEFFhello', 'utf8');
    const bom = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      old_string: '\uFEFFhello',
      new_string: '\uFEFFworld',
    });
    expect(bom.ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('\uFEFFworld');

    await writeFile(path, '\uFEFFalpha\nmarker', 'utf8');
    const misplacedBom = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      old_string: '\uFEFFmarker',
      new_string: 'changed',
    });
    expect(misplacedBom).toMatchObject({ ok: false });
    expect(await readFile(path, 'utf8')).toBe('\uFEFFalpha\nmarker');
  });

  it('拒绝通过工作区内 symlink 绕过敏感路径 deny-list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-edit-helper-'));
    await writeFile(join(root, '.env'), 'TOKEN=old', 'utf8');
    await symlink('.env', join(root, 'safe.txt'));

    const result = runHelper(root, {
      op: 'edit',
      file_path: 'safe.txt',
      old_string: 'old',
      new_string: 'leaked',
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/refused symlink/);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('TOKEN=old');
  });

  it('结果超过 1MB 时在写盘前拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-edit-helper-'));
    const path = join(root, 'a.txt');
    const original = 'x x';
    await writeFile(path, original, 'utf8');

    const result = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      old_string: 'x',
      new_string: 'y'.repeat(600_000),
      replace_all: true,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/result too large/);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('替换命中超过 10000 处时拒绝且不写盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-edit-helper-'));
    const path = join(root, 'a.txt');
    const original = 'a'.repeat(10_001);
    await writeFile(path, original, 'utf8');

    const result = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/match count exceeds 10000/);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('批量 edits 对原文匹配并拒绝重叠', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-edit-helper-'));
    const path = join(root, 'a.txt');
    await writeFile(path, 'alpha beta gamma', 'utf8');

    const success = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      edits: [
        { old_string: 'alpha', new_string: 'beta' },
        { old_string: 'beta', new_string: 'delta' },
      ],
    });
    expect(success.ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('beta delta gamma');

    await writeFile(path, 'alpha beta gamma', 'utf8');
    const failure = runHelper(root, {
      op: 'edit',
      file_path: 'a.txt',
      edits: [
        { old_string: 'alpha beta', new_string: 'x' },
        { old_string: 'beta gamma', new_string: 'y' },
      ],
    });
    expect(failure).toMatchObject({ ok: false });
    expect(failure.error).toMatch(/overlap.*merge them into one edit/);
    expect(await readFile(path, 'utf8')).toBe('alpha beta gamma');
  });
});

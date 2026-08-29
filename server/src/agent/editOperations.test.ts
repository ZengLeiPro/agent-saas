import { describe, expect, it } from 'vitest';

import {
  MAX_EDIT_DIFF_BYTES,
  applyWorkspaceEdits,
  normalizeForFuzzyMatch,
} from './editOperations.js';

describe('applyWorkspaceEdits', () => {
  it('在 LF 匹配空间编辑，并还原 BOM 与 CRLF', () => {
    const content = '\uFEFFfirst\r\nsecond\r\n';
    const result = applyWorkspaceEdits(
      content,
      [
        {
          old_string: 'first\nsecond',
          new_string: 'FIRST\nsecond',
        },
      ],
      'a.txt',
    );

    expect(result.updatedContent).toBe('\uFEFFFIRST\r\nsecond\r\n');
    expect(result.bomPreserved).toBe(true);
    expect(result.lineEnding).toBe('\r\n');
    expect(result.fuzzyMatches).toBe(0);
  });

  it('精确失败后归一化弯引号、Unicode 破折号、特殊空格与行尾空白', () => {
    const content = 'const title = “Agent”—ready;\u00A0 \nnext\n';
    const result = applyWorkspaceEdits(
      content,
      [
        {
          old_string: 'const title = "Agent"-ready;\nnext',
          new_string: 'const title = "Agent"-done;\nnext',
        },
      ],
      'a.ts',
    );

    expect(result.updatedContent).toBe('const title = "Agent"-done;\nnext\n');
    expect(result.fuzzyMatches).toBe(1);
  });

  it('只修改命中范围，不重写目标外的混合行尾', () => {
    const result = applyWorkspaceEdits(
      'a\r\nb\nc\r\n',
      [
        {
          old_string: 'b',
          new_string: 'B',
        },
      ],
      'mixed.txt',
    );

    expect(result.updatedContent).toBe('a\r\nB\nc\r\n');
    expect(result.lineEnding).toBe('\r\n');
  });

  it('NFKC fuzzy 支持跨码点组合字符', () => {
    const result = applyWorkspaceEdits(
      'cafe\u0301',
      [
        {
          old_string: 'café',
          new_string: 'coffee',
        },
      ],
      'unicode.txt',
    );

    expect(result.updatedContent).toBe('coffee');
    expect(result.fuzzyMatches).toBe(1);
  });

  it('拒绝只命中 NFKC 扩展 grapheme 的内部片段', () => {
    expect(() =>
      applyWorkspaceEdits(
        'oﬃce',
        [
          {
            old_string: 'fi',
            new_string: 'X',
          },
        ],
        'ligature.txt',
      ),
    ).toThrow(/not found/);

    expect(
      applyWorkspaceEdits(
        'oﬃce',
        [
          {
            old_string: 'office',
            new_string: 'work',
          },
        ],
        'ligature.txt',
      ).updatedContent,
    ).toBe('work');
  });

  it('legacy old/new 包含 BOM 时仍命中且不会生成双 BOM', () => {
    const result = applyWorkspaceEdits(
      '\uFEFFhello',
      [
        {
          old_string: '\uFEFFhello',
          new_string: '\uFEFFworld',
        },
      ],
      'bom.txt',
    );

    expect(result.updatedContent).toBe('\uFEFFworld');
    expect(result.updatedContent.startsWith('\uFEFF\uFEFF')).toBe(false);
  });

  it('old_string 含 BOM 时只允许命中文件首位', () => {
    expect(() =>
      applyWorkspaceEdits(
        '\uFEFFalpha\nmarker',
        [
          {
            old_string: '\uFEFFmarker',
            new_string: 'changed',
          },
        ],
        'bom.txt',
      ),
    ).toThrow(/not found/);
  });

  it('拒绝把小文件通过 replace_all 放大到 1MB 以上', () => {
    expect(() =>
      applyWorkspaceEdits(
        'x x',
        [
          {
            old_string: 'x',
            new_string: 'y'.repeat(600_000),
            replace_all: true,
          },
        ],
        'large.txt',
      ),
    ).toThrow(/result too large/);
  });

  it('替换命中超过 10000 处时快速拒绝', () => {
    expect(() =>
      applyWorkspaceEdits(
        'a'.repeat(10_001),
        [
          {
            old_string: 'a',
            new_string: 'b',
            replace_all: true,
          },
        ],
        'many.txt',
      ),
    ).toThrow(/match count exceeds 10000/);
  });

  it('批量 edits 全部针对原始文件匹配，而不是逐项增量匹配', () => {
    const result = applyWorkspaceEdits(
      'alpha beta gamma',
      [
        { old_string: 'alpha', new_string: 'beta' },
        { old_string: 'beta', new_string: 'delta' },
      ],
      'a.txt',
    );

    expect(result.updatedContent).toBe('beta delta gamma');
    expect(result.editCount).toBe(2);
    expect(result.replacements).toBe(2);
  });

  it('拒绝批量 edit 的重叠范围', () => {
    expect(() =>
      applyWorkspaceEdits(
        'alpha beta gamma',
        [
          { old_string: 'alpha beta', new_string: 'x' },
          { old_string: 'beta gamma', new_string: 'y' },
        ],
        'a.txt',
      ),
    ).toThrow(/overlap.*merge them into one edit/);
  });

  it('每个 edit 独立支持 replace_all', () => {
    const result = applyWorkspaceEdits(
      'x x x / y y',
      [
        { old_string: 'x', new_string: 'X', replace_all: true },
        { old_string: 'y', new_string: 'Y', replace_all: true },
      ],
      'a.txt',
    );

    expect(result.updatedContent).toBe('X X X / Y Y');
    expect(result.replacements).toBe(5);
    expect(result.occurrences).toBe(5);
  });

  it('非 replace_all 的多处命中给出可执行错误', () => {
    expect(() =>
      applyWorkspaceEdits('x x x', [{ old_string: 'x', new_string: 'X' }], 'a.txt'),
    ).toThrow(/matched 3 times.*replace_all=true/);
  });

  it('返回有界 unified diff 与首个变更行', () => {
    const oldContent = `first\n${'a'.repeat(80_000)}\nlast\n`;
    const result = applyWorkspaceEdits(
      oldContent,
      [
        {
          old_string: 'a'.repeat(80_000),
          new_string: 'b'.repeat(80_000),
        },
      ],
      'large.txt',
    );

    expect(result.firstChangedLine).toBe(2);
    expect(result.diff).toContain('--- large.txt');
    expect(Buffer.byteLength(result.diff, 'utf8')).toBeLessThanOrEqual(MAX_EDIT_DIFF_BYTES);
    expect(result.diffTruncated).toBe(true);
  });
});

describe('normalizeForFuzzyMatch', () => {
  it('使用 NFKC 并保留非行尾空白', () => {
    expect(normalizeForFuzzyMatch('Ａ\u3000B  \n')).toBe('A B\n');
  });
});

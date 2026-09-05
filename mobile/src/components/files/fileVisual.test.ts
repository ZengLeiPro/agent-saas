import { describe, expect, it } from 'vitest';
import { getFileTypeVisual } from '@agent/shared';
import { FILE_VISUAL_CATEGORIES, resolveFileVisual, resolveFileVisualCategory } from './fileVisual';

describe('resolveFileVisualCategory', () => {
  it('目录优先于扩展名判定', () => {
    expect(resolveFileVisualCategory({ isDirectory: true, name: 'assets.pdf' })).toBe('folder');
  });

  it('与 Web fileIcons 同一套类别映射', () => {
    const cases: Array<[string, string]> = [
      ['报告.pdf', 'pdf'],
      ['合同.docx', 'word'],
      ['汇报.pptx', 'ppt'],
      ['明细.xlsx', 'excel'],
      ['data.csv', 'excel'],
      ['index.ts', 'code'],
      ['page.html', 'code'],
      ['icon.svg', 'image'],
      ['clip.mp4', 'video'],
      ['voice.m4a', 'audio'],
      ['readme.md', 'text'],
      ['bundle.tar', 'archive'],
      ['无扩展名', 'default'],
      ['unknown.xyz', 'default'],
    ];
    for (const [name, expected] of cases) {
      expect(resolveFileVisualCategory({ isDirectory: false, name }), name).toBe(expected);
    }
  });

  it('扩展名大小写不敏感', () => {
    expect(resolveFileVisualCategory({ isDirectory: false, name: 'A.PDF' })).toBe('pdf');
  });
});

describe('resolveFileVisual', () => {
  it('目录不吃 shared 色板（由主题品牌色接管）', () => {
    expect(resolveFileVisual({ isDirectory: true, name: 'assets' })).toEqual({
      category: 'folder',
      color: null,
    });
  });

  it('文件按深浅色取 shared 色板值（色板唯一来源是 shared，不在 mobile 复写 hex）', () => {
    const pdf = getFileTypeVisual('a.pdf');
    expect(resolveFileVisual({ isDirectory: false, name: 'a.pdf' }, false).color).toBe(pdf.color);
    expect(resolveFileVisual({ isDirectory: false, name: 'a.pdf' }, true).color).toBe(pdf.colorDark);

    // default 是唯一深浅色取值不同的类别：isDark 开关必须真的生效
    const fallback = getFileTypeVisual('a.xyz');
    expect(fallback.colorDark).not.toBe(fallback.color);
    expect(resolveFileVisual({ isDirectory: false, name: 'a.xyz' }, false).color).toBe(
      fallback.color,
    );
    expect(resolveFileVisual({ isDirectory: false, name: 'a.xyz' }, true).color).toBe(
      fallback.colorDark,
    );
  });
});

describe('FILE_VISUAL_CATEGORIES', () => {
  it('枚举齐全：任何文件解析出的类别都在枚举里', () => {
    // `src/lib/icons.ts` 的 FileTypeIcons 用 `satisfies Record<FileTypeCategory | 'folder'>`
    // 保证图标注册表覆盖同一集合（缺一个类别就编译失败），这里守住枚举本身不漏项。
    const samples = [
      { isDirectory: true, name: 'assets' },
      { isDirectory: false, name: 'a.pdf' },
      { isDirectory: false, name: 'a.docx' },
      { isDirectory: false, name: 'a.pptx' },
      { isDirectory: false, name: 'a.xlsx' },
      { isDirectory: false, name: 'a.ts' },
      { isDirectory: false, name: 'a.png' },
      { isDirectory: false, name: 'a.mp4' },
      { isDirectory: false, name: 'a.mp3' },
      { isDirectory: false, name: 'a.md' },
      { isDirectory: false, name: 'a.zip' },
      { isDirectory: false, name: 'a.bin' },
    ];
    const resolved = samples.map(resolveFileVisualCategory);
    expect([...new Set(resolved)].sort()).toEqual([...FILE_VISUAL_CATEGORIES].sort());
  });
});

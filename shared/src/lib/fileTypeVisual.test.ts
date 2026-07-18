/**
 * fileTypeVisual.ts 测试
 *
 * getFileTypeVisual：按扩展名映射类别 + 色板。
 * 覆盖各类别代表扩展名、大小写不敏感、无扩展名/未知扩展名回退 default、
 * 以及 default 类别 color/colorDark 不同的特例。
 */
import { describe, expect, it } from 'vitest';
import { getFileTypeVisual } from './fileTypeVisual';

describe('getFileTypeVisual', () => {
  it('各类别代表扩展名映射正确', () => {
    expect(getFileTypeVisual('a.pdf').category).toBe('pdf');
    expect(getFileTypeVisual('a.docx').category).toBe('word');
    expect(getFileTypeVisual('a.pptx').category).toBe('ppt');
    expect(getFileTypeVisual('a.xlsx').category).toBe('excel');
    expect(getFileTypeVisual('a.csv').category).toBe('excel');
    expect(getFileTypeVisual('a.ts').category).toBe('code');
    expect(getFileTypeVisual('a.png').category).toBe('image');
    expect(getFileTypeVisual('a.mp4').category).toBe('video');
    expect(getFileTypeVisual('a.mp3').category).toBe('audio');
    expect(getFileTypeVisual('a.md').category).toBe('text');
    expect(getFileTypeVisual('a.zip').category).toBe('archive');
  });

  it('扩展名大小写不敏感', () => {
    expect(getFileTypeVisual('REPORT.PDF').category).toBe('pdf');
    expect(getFileTypeVisual('Photo.JPG').category).toBe('image');
  });

  it('多点文件名取最后一段扩展名', () => {
    expect(getFileTypeVisual('archive.tar.gz').category).toBe('archive');
    expect(getFileTypeVisual('component.test.ts').category).toBe('code');
  });

  it('未知扩展名回退 default', () => {
    const v = getFileTypeVisual('a.unknownext');
    expect(v.category).toBe('default');
  });

  it('无扩展名回退 default', () => {
    expect(getFileTypeVisual('README').category).toBe('default');
    expect(getFileTypeVisual('').category).toBe('default');
  });

  it('返回对应类别的 color 与 colorDark', () => {
    expect(getFileTypeVisual('a.pdf')).toEqual({ category: 'pdf', color: '#EF4444', colorDark: '#EF4444' });
  });

  it('default 类别的 colorDark 与 color 不同（唯一特例）', () => {
    const v = getFileTypeVisual('noext');
    expect(v.color).toBe('#9CA3AF');
    expect(v.colorDark).toBe('#6B7280');
    expect(v.color).not.toBe(v.colorDark);
  });
});

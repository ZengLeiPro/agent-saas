import { describe, expect, it } from 'vitest';
import {
  FILES_ADMIN_ROOT,
  FILES_USER_ROOT,
  isFilesUserRoot,
  resolveFileEntryPress,
} from './fileEntryPress';

function entry(overrides: Record<string, unknown>) {
  return {
    path: 'assets/note.md',
    name: 'note.md',
    size: 12,
    modifiedAt: 1,
    isDirectory: false,
    ...overrides,
  };
}

describe('resolveFileEntryPress', () => {
  it('treats directories as folder drill', () => {
    expect(
      resolveFileEntryPress(entry({ isDirectory: true, path: 'assets/docs', name: 'docs' })),
    ).toEqual({
      kind: 'folder',
      path: 'assets/docs',
    });
  });

  it('routes markdown to markdown-preview', () => {
    const decision = resolveFileEntryPress(entry({ name: 'readme.md', path: 'assets/readme.md' }));
    expect(decision.kind).toBe('preview');
    if (decision.kind === 'preview') {
      expect(decision.target.route).toBe('/chat/markdown-preview');
      expect(decision.target.filePath).toBe('assets/readme.md');
    }
  });

  it('routes pdf/code to files/preview', () => {
    const pdf = resolveFileEntryPress(entry({ name: 'a.pdf', path: 'assets/a.pdf' }));
    expect(pdf.kind).toBe('preview');
    if (pdf.kind === 'preview') expect(pdf.target.route).toBe('/files/preview');
  });

  it('opens binaries via the OS share path', () => {
    expect(resolveFileEntryPress(entry({ name: 'a.zip', path: 'assets/a.zip' }))).toEqual({
      kind: 'open',
    });
  });
});

describe('isFilesUserRoot', () => {
  it('recognizes the user files root', () => {
    expect(isFilesUserRoot(FILES_USER_ROOT)).toBe(true);
    expect(isFilesUserRoot('assets/docs')).toBe(false);
    expect(isFilesUserRoot(FILES_ADMIN_ROOT)).toBe(false);
  });
});

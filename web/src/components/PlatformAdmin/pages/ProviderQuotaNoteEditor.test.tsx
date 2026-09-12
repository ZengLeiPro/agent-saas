import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_QUOTA_NOTE_STORAGE_KEY,
  ProviderQuotaNoteEditor,
} from './ProviderQuotaNoteEditor';

describe('ProviderQuotaNoteEditor', () => {
  beforeEach(() => {
    window.localStorage.removeItem(PROVIDER_QUOTA_NOTE_STORAGE_KEY);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(PROVIDER_QUOTA_NOTE_STORAGE_KEY);
  });

  it('可以编辑并保存账号备注，长备注展示时保持截断', () => {
    const longNote = '这是一个较长的套餐备注，用于确认展示区域不会挤压右侧的到期时间。';
    window.localStorage.setItem(
      PROVIDER_QUOTA_NOTE_STORAGE_KEY,
      JSON.stringify({ 'codex:a': longNote }),
    );

    render(<ProviderQuotaNoteEditor accountKey="codex:a" accountLabel="a@example.com" />);

    const displayedNote = screen.getByTitle(longNote);
    expect(displayedNote.className).toContain('truncate');
    expect(displayedNote.parentElement?.className).toContain('max-w-40');

    fireEvent.click(screen.getByRole('button', { name: '编辑 a@example.com 备注' }));
    const textarea = screen.getByRole('textbox', { name: '备注内容' });
    fireEvent.change(textarea, { target: { value: '续费前确认额度' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByText('续费前确认额度')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(PROVIDER_QUOTA_NOTE_STORAGE_KEY) ?? '{}')).toEqual({
      'codex:a': '续费前确认额度',
    });
  });

  it('保存空备注会移除当前账号的备注', () => {
    window.localStorage.setItem(
      PROVIDER_QUOTA_NOTE_STORAGE_KEY,
      JSON.stringify({ 'codex:a': '待清理', 'codex:b': '保留' }),
    );

    render(<ProviderQuotaNoteEditor accountKey="codex:a" accountLabel="a@example.com" />);
    fireEvent.click(screen.getByRole('button', { name: '编辑 a@example.com 备注' }));
    fireEvent.change(screen.getByRole('textbox', { name: '备注内容' }), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.queryByText('待清理')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PROVIDER_QUOTA_NOTE_STORAGE_KEY) ?? '{}')).toEqual({
      'codex:b': '保留',
    });
  });
});

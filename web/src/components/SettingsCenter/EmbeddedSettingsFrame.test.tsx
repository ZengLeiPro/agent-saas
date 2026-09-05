import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EmbeddedSettingsFrame } from './EmbeddedSettingsFrame';

vi.mock('@/components/ChangePasswordDialog', () => ({ ChangePasswordDialog: () => null }));

describe('EmbeddedSettingsFrame 统一布局', () => {
  it('将宽度和滚动统一收口到个人设置工作区外层', () => {
    render(
      <EmbeddedSettingsFrame
        content={<div>个人设置内容</div>}
        showPasswordDialog={false}
        onShowPasswordDialogChange={vi.fn()}
        avatarUploading={false}
      />,
    );

    const frame = screen.getByTestId('personal-settings-content');
    expect(frame.className).toContain('overflow-y-auto');
    expect(frame.firstElementChild?.className).toContain('max-w-5xl');
    expect(frame.firstElementChild?.className).toContain('min-h-full');
    expect(screen.getByText('个人设置内容')).toBeTruthy();
  });
});

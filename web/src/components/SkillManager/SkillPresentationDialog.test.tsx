import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillPresentationDialog, type SkillPresentationTarget } from './SkillPresentationDialog';

const mocks = vi.hoisted(() => ({
  SkillPresentationApiError: class SkillPresentationApiError extends Error {
    constructor(
      message: string,
      readonly code?: string,
      readonly changed = false,
    ) {
      super(message);
    }
  },
  deleteTenantPlatformSkillPresentation: vi.fn(),
  updatePlatformSkillPresentation: vi.fn(),
  updateTenantOwnSkillPresentation: vi.fn(),
  updateTenantPlatformSkillPresentation: vi.fn(),
}));

vi.mock('@agent/shared', () => ({
  SkillPresentationApiError: mocks.SkillPresentationApiError,
  deleteTenantPlatformSkillPresentation: (...args: unknown[]) =>
    mocks.deleteTenantPlatformSkillPresentation(...args),
  updatePlatformSkillPresentation: (...args: unknown[]) =>
    mocks.updatePlatformSkillPresentation(...args),
  updateTenantOwnSkillPresentation: (...args: unknown[]) =>
    mocks.updateTenantOwnSkillPresentation(...args),
  updateTenantPlatformSkillPresentation: (...args: unknown[]) =>
    mocks.updateTenantPlatformSkillPresentation(...args),
}));

const platformTarget: SkillPresentationTarget = {
  kind: 'platform',
  skill: {
    id: 'weekly-report',
    name: 'weekly-report',
    description: 'Generate weekly reports',
    presentation: {
      displayName: '周报助手',
      summary: '汇总工作内容并生成周报',
      locale: 'zh-CN',
      source: 'platform_default',
      revision: 3,
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updatePlatformSkillPresentation.mockResolvedValue({ ok: true });
  mocks.deleteTenantPlatformSkillPresentation.mockResolvedValue({ ok: true });
});

describe('SkillPresentationDialog', () => {
  it('保存平台展示信息时携带当前修订号，不修改技术标识', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn(async () => undefined);
    render(<SkillPresentationDialog target={platformTarget} onClose={onClose} onSaved={onSaved} />);

    expect(screen.getByText('技术标识：weekly-report')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('展示名称'), { target: { value: '企业周报助手' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^卡片简介/ }), {
      target: { value: '自动整理本周进展与下周计划' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.updatePlatformSkillPresentation).toHaveBeenCalledWith('weekly-report', {
        displayName: '企业周报助手',
        summary: '自动整理本周进展与下周计划',
        expectedRevision: 3,
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('组织覆盖可以恢复平台默认展示信息', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn(async () => undefined);
    const target: SkillPresentationTarget = {
      kind: 'tenant-platform',
      tenantId: 'tenant-a',
      skill: {
        ...platformTarget.skill,
        presentation: {
          ...platformTarget.skill.presentation!,
          displayName: '甲组织周报',
          source: 'organization_override',
          revision: 2,
        },
      },
    };
    render(<SkillPresentationDialog target={target} onClose={onClose} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: '恢复平台默认' }));
    await waitFor(() =>
      expect(mocks.deleteTenantPlatformSkillPresentation).toHaveBeenCalledWith(
        'tenant-a',
        'weekly-report',
        2,
      ),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('revision 冲突后刷新列表并关闭旧草稿，避免携带旧版本无限重试', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn(async () => undefined);
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    mocks.updatePlatformSkillPresentation.mockRejectedValueOnce(
      new mocks.SkillPresentationApiError('版本冲突', 'SKILL_PRESENTATION_VERSION_CONFLICT'),
    );
    render(<SkillPresentationDialog target={platformTarget} onClose={onClose} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('列表已刷新'));
  });

  it('关闭有改动的草稿前要求确认', () => {
    const onClose = vi.fn();
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(
      <SkillPresentationDialog
        target={platformTarget}
        onClose={onClose}
        onSaved={vi.fn(async () => undefined)}
      />,
    );
    fireEvent.change(screen.getByLabelText('展示名称'), { target: { value: '未保存名称' } });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

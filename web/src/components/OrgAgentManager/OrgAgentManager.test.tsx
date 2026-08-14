import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthFetch, mockUseOrgAgentAdmin } = vi.hoisted(() => ({
  mockAuthFetch: vi.fn(),
  mockUseOrgAgentAdmin: vi.fn(),
}));

vi.mock('@/lib/authFetch', () => ({
  authFetch: mockAuthFetch,
  setOnUnauthorized: vi.fn(),
}));

vi.mock('@agent/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agent/shared');
  return {
    ...actual,
    authFetch: mockAuthFetch,
    setOnUnauthorized: vi.fn(),
  };
});

vi.mock('@/components/UserManager/hooks', () => ({
  useUsers: () => ({ users: [], loading: false, error: null }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    isPlatformAdmin: true,
    isSuperAdmin: true,
    canPlatform: () => true,
  }),
}));

vi.mock('./hooks', () => ({
  useOrgAgentAdmin: mockUseOrgAgentAdmin,
  useTenantSkillOptions: () => ({ skills: [], loading: false }),
}));

// 屏蔽 SettingsPanelHeader 的重样式，避免污染 DOM 断言
vi.mock('@/components/SettingsCenter/SettingsPanelHeader', () => ({
  SettingsPanelHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h2>{title}</h2>
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock('@/components/OrgAgentAvatar', () => ({
  OrgAgentAvatarContent: () => <span>avatar</span>,
}));

import { OrgAgentManager } from './index';
import {
  assembleScopeDescription,
  emptyFormValues,
  parseGateSlots,
  parseOrgAgentAdminList,
  type OrgAgentAdminRecord,
} from './types';
import { FALLBACK_TEMPLATES } from './templates';

beforeEach(() => {
  mockAuthFetch.mockReset();
  mockUseOrgAgentAdmin.mockReset();
  mockUseOrgAgentAdmin.mockReturnValue({
    agents: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    uploadAvatar: vi.fn(),
  });
  // 默认：expert-templates 端点未部署 → hook 返回 fallback
  mockAuthFetch.mockImplementation(async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  }));
});

function adminRecord(overrides: Partial<OrgAgentAdminRecord> = {}): OrgAgentAdminRecord {
  return {
    id: 'oa-valid',
    tenantId: 'kaiyan',
    name: '报价助手',
    description: '审核报价',
    starterPrompts: [],
    instructions: '仅审核报价',
    allowedSkills: [],
    audience: { exposure: 'all', usernames: [] },
    guardrail: {
      enabled: false,
      scopeDescription: '',
      rejectionMessage: '超出范围',
      strictness: 'strict',
    },
    enabled: true,
    createdAt: '2026-08-14T00:00:00.000Z',
    createdBy: 'admin',
    updatedAt: '2026-08-14T00:00:00.000Z',
    updatedBy: 'admin',
    ...overrides,
  };
}

describe('OrgAgentManager - 数据合同', () => {
  it('audience 异常资源被隔离时显示安全错误状态，不渲染空列表误导', () => {
    mockUseOrgAgentAdmin.mockReturnValue({
      agents: [],
      dataIssues: [{
        key: 'oa-platform-metadata',
        resourceId: 'oa-platform-metadata',
        message: '可见范围配置缺失或格式错误，已按安全策略隐藏',
      }],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      uploadAvatar: vi.fn(),
    });

    render(<OrgAgentManager tenantId="kaiyan" tenantName="开沿演示组织" />);
    expect(screen.getByText('1 条资源数据不完整，已安全隐藏')).toBeTruthy();
    expect(screen.getByText(/现有资源的数据不完整/)).toBeTruthy();
    expect(screen.queryByText(/还没有企业专家/)).toBeNull();
  });

  it('接口失败时显示明确错误与重试入口', () => {
    const refresh = vi.fn();
    mockUseOrgAgentAdmin.mockReturnValue({
      agents: [],
      dataIssues: [],
      loading: false,
      error: '获取企业专家失败',
      refresh,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      uploadAvatar: vi.fn(),
    });

    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/企业专家加载失败/)).toBeTruthy();
  });

  it('编辑时保留 deny_users、departmentIds 与 roles，不扩大或丢失既有范围', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    mockUseOrgAgentAdmin.mockReturnValue({
      agents: [adminRecord({
        audience: {
          exposure: 'deny_users',
          usernames: ['blocked-user'],
          departmentIds: ['dept-sales'],
          roles: ['sales-lead'],
        },
      })],
      dataIssues: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update,
      remove: vi.fn(),
      uploadAvatar: vi.fn(),
    });

    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByTitle('编辑'));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByRole('radio', { name: '排除指定成员' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('oa-valid', expect.objectContaining({
      audience: {
        exposure: 'deny_users',
        usernames: ['blocked-user'],
        departmentIds: ['dept-sales'],
        roles: ['sales-lead'],
      },
    }));
  });

  it('组织切换后旧提交完成不会关闭或污染新组织弹窗', async () => {
    let resolveCreate!: () => void;
    const create = vi.fn(() => new Promise<void>((resolve) => { resolveCreate = resolve; }));
    mockUseOrgAgentAdmin.mockReturnValue({
      agents: [],
      dataIssues: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create,
      update: vi.fn(),
      remove: vi.fn(),
      uploadAvatar: vi.fn(),
    });

    const view = render(<OrgAgentManager tenantId="tenant-a" />);
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const firstDialog = await screen.findByRole('dialog');
    fireEvent.change(within(firstDialog).getByPlaceholderText('如：产品选型助手'), {
      target: { value: '旧组织专家' },
    });
    fireEvent.click(within(firstDialog).getByRole('button', { name: '创建' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    view.rerender(<OrgAgentManager tenantId="tenant-b" />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const secondDialog = await screen.findByRole('dialog');
    const secondName = within(secondDialog).getByPlaceholderText('如：产品选型助手') as HTMLInputElement;
    fireEvent.change(secondName, { target: { value: '新组织专家' } });

    await act(async () => { resolveCreate(); });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(secondName.value).toBe('新组织专家');
    expect(within(secondDialog).getByRole('button', { name: '创建' })).toBeTruthy();
  });
});

describe('OrgAgentManager - 门禁填空 / 模板卡 / 试测按钮', () => {
  it('渲染 3 张种子模板卡（报价审核 / 客户情报 / 合同风险）', async () => {
    render(<OrgAgentManager tenantId="kaiyan" tenantName="开沿科技" />);
    // 模板 fallback 直接从静态导入
    for (const template of FALLBACK_TEMPLATES) {
      expect(await screen.findByText(template.name)).toBeTruthy();
    }
    const useButtons = screen.getAllByRole('button', { name: '使用此模板' });
    expect(useButtons.length).toBe(FALLBACK_TEMPLATES.length);
  });

  it('点击"使用此模板"打开编辑表单并预填名称', async () => {
    render(<OrgAgentManager tenantId="kaiyan" />);
    await screen.findByText('报价审核助手');
    const cards = screen.getAllByRole('button', { name: '使用此模板' });
    fireEvent.click(cards[0]);
    // 等对话框出现（DialogTitle 会是"创建企业专家"）
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('创建企业专家')).toBeTruthy();
    // 名称字段预填第一个模板名（报价审核助手）
    const nameInput = within(dialog).getByPlaceholderText('如：产品选型助手') as HTMLInputElement;
    expect(nameInput.value).toBe('报价审核助手');
  });

  it('模板卡预填门禁字段：mode=shadow + allowExamples 非空', async () => {
    render(<OrgAgentManager tenantId="kaiyan" />);
    await screen.findByText('报价审核助手');
    fireEvent.click(screen.getAllByRole('button', { name: '使用此模板' })[0]);
    const dialog = await screen.findByRole('dialog');
    // shadow radio 应被选中
    const shadowRadio = within(dialog).getByRole('radio', { name: /影子模式/ }) as HTMLInputElement;
    expect(shadowRadio.checked).toBe(true);
    // 报价审核允许问示例包括"粘贴一份报价单让我审"
    expect(within(dialog).getByText('粘贴一份报价单让我审')).toBeTruthy();
  });

  it('mode=off 时隐藏允许/拒绝示例、strictness、试测按钮', async () => {
    render(<OrgAgentManager tenantId="kaiyan" />);
    // 打开空白新建表单
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const dialog = await screen.findByRole('dialog');
    // 默认 mode=off（emptyFormValues）
    const offRadio = within(dialog).getByRole('radio', { name: /^关闭/ }) as HTMLInputElement;
    expect(offRadio.checked).toBe(true);
    // 关闭时不显示"允许问的问题类型"
    expect(within(dialog).queryByText('允许问的问题类型')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /试测门禁/ })).toBeNull();
  });

  it('切到 shadow 后添加/删除允许问 chip', async () => {
    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const dialog = await screen.findByRole('dialog');
    // 切到 shadow
    fireEvent.click(within(dialog).getByRole('radio', { name: /影子模式/ }));
    // 允许问 input + 添加按钮出现
    const allowInput = within(dialog).getByLabelText('新增允许问示例') as HTMLInputElement;
    fireEvent.change(allowInput, { target: { value: '帮我审报价单' } });
    // 找允许问区域下方的第一个"添加"按钮（allow 在 reject 之前）
    const addButtons = within(dialog).getAllByRole('button', { name: /添加/ });
    fireEvent.click(addButtons[0]);
    expect(within(dialog).getByText('帮我审报价单')).toBeTruthy();
    // 删除该 chip
    const removeBtn = within(dialog).getByRole('button', { name: '删除允许项 帮我审报价单' });
    fireEvent.click(removeBtn);
    expect(within(dialog).queryByText('帮我审报价单')).toBeNull();
  });

  it('点击"试测门禁"打开输入区，调后端 gate-preview 并展示结果', async () => {
    // 覆盖 authFetch：默认给 404 templates，然后 gate-preview 返回 in_scope
    mockAuthFetch.mockImplementation(async (url: string) => {
      if (url.includes('gate-preview')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            verdict: 'in_scope',
            wouldReject: false,
            latencyMs: 123,
            source: 'model',
            model: 'doubao-1.5-lite',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const dialog = await screen.findByRole('dialog');
    // 用 value 属性锁定 enforce radio，避免 "生效" 出现在多处 accessible name
    const enforceRadio = within(dialog).getByRole('radio', { name: /门禁生效/ });
    fireEvent.click(enforceRadio);
    // 展开试测面板（多个按钮都可能含"试测"文本，用 aria-label 更稳）
    const openTestBtn = within(dialog)
      .getAllByRole('button')
      .find((btn) => /^试测门禁$/.test(btn.textContent?.trim() ?? ''));
    expect(openTestBtn).toBeTruthy();
    fireEvent.click(openTestBtn!);
    const testInput = within(dialog).getByLabelText('试测问题') as HTMLInputElement;
    fireEvent.change(testInput, { target: { value: '帮我审报价' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '试测' }));
    // 等结果
    await waitFor(() => {
      expect(within(dialog).getByText(/通过.*in_scope/)).toBeTruthy();
    });
    expect(within(dialog).getByText(/123 ms/)).toBeTruthy();
    // 端点调用了 gate-preview
    expect(mockAuthFetch).toHaveBeenCalledWith(
      '/api/org-agents/gate-preview',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('types::assembleScopeDescription / parseGateSlots 往返序列化', () => {
  it('拼装 scopeDescription 带 gate-slots 标记', () => {
    const assembled = assembleScopeDescription({
      mode: 'shadow',
      description: '审报价单',
      allowExamples: ['审报价', '看账期'],
      rejectExamples: ['写周报'],
      strictness: 'strict',
    });
    expect(assembled.startsWith('<!--gate-slots:')).toBe(true);
    expect(assembled).toContain('【允许问】');
    expect(assembled).toContain('· 审报价');
    expect(assembled).toContain('【拿不准时】拒答');
  });

  it('parseGateSlots 从 marker 恢复结构化 slots', () => {
    const assembled = assembleScopeDescription({
      mode: 'enforce',
      description: '审合同',
      allowExamples: ['审合同'],
      rejectExamples: ['写周报'],
      strictness: 'lenient',
    });
    const parsed = parseGateSlots(assembled);
    expect(parsed.slots).not.toBeNull();
    expect(parsed.slots?.mode).toBe('enforce');
    expect(parsed.slots?.allowExamples).toEqual(['审合同']);
    expect(parsed.slots?.rejectExamples).toEqual(['写周报']);
  });

  it('parseGateSlots 对遗留 raw prompt 兜底', () => {
    const parsed = parseGateSlots('自由文本，无标记');
    expect(parsed.slots).toBeNull();
    expect(parsed.rawScope).toBe('自由文本，无标记');
  });
});

describe('parseOrgAgentAdminList 数据合同', () => {
  const validRecord = {
    id: 'oa-valid',
    tenantId: 'kaiyan',
    name: '报价助手',
    description: '审核报价',
    starterPrompts: [],
    instructions: '仅审核报价',
    allowedSkills: [],
    audience: { exposure: 'all', usernames: [] },
    guardrail: {
      enabled: false,
      scopeDescription: '',
      rejectionMessage: '超出范围',
      strictness: 'strict',
    },
    enabled: true,
    createdAt: '2026-08-14T00:00:00.000Z',
    createdBy: 'admin',
    updatedAt: '2026-08-14T00:00:00.000Z',
    updatedBy: 'admin',
  };

  it('接受 audience/exposure 正常记录与空列表', () => {
    expect(parseOrgAgentAdminList([validRecord])).toMatchObject({
      agents: [{ id: 'oa-valid', audience: { exposure: 'all', usernames: [] } }],
      issues: [],
    });
    expect(parseOrgAgentAdminList([])).toEqual({ agents: [], issues: [] });
  });

  it.each([
    ['缺失', undefined],
    ['null', null],
    ['缺少 exposure', { usernames: [] }],
    ['缺少 usernames', { exposure: 'allow_users' }],
    ['非法空用户名', { exposure: 'deny_users', usernames: [''] }],
    ['非法空部门', { exposure: 'allow_users', usernames: [], departmentIds: [''] }],
    ['非法空角色', { exposure: 'allow_users', usernames: [], roles: [''] }],
  ])('audience %s 时隔离资源且不推断 exposure', (_label, audience) => {
    const result = parseOrgAgentAdminList([{ ...validRecord, id: `oa-${_label}`, audience }]);
    expect(result.agents).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      resourceId: `oa-${_label}`,
      message: expect.stringContaining('可见范围配置缺失'),
    })]);
  });

  it('列表顶层合同错误时作为接口失败处理', () => {
    expect(() => parseOrgAgentAdminList({ items: [] })).toThrow('企业专家接口返回格式无效');
  });
});

describe('emptyFormValues 兼容', () => {
  it('默认 mode=off / allowExamples 空', () => {
    const values = emptyFormValues();
    expect(values.guardrailMode).toBe('off');
    expect(values.guardrailAllowExamples).toEqual([]);
    expect(values.guardrailRejectExamples).toEqual([]);
  });
});

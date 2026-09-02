import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthFetch,
  mockUseOrgAgentAdmin,
  mockLoadConfiguration,
  mockSaveConfiguration,
  mockUpdateStatus,
  mockUploadAvatar,
} = vi.hoisted(() => ({
  mockAuthFetch: vi.fn(),
  mockUseOrgAgentAdmin: vi.fn(),
  mockLoadConfiguration: vi.fn(),
  mockSaveConfiguration: vi.fn(),
  mockUpdateStatus: vi.fn(),
  mockUploadAvatar: vi.fn(),
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
    isPlatformAdmin: false,
    isSuperAdmin: false,
    canPlatform: () => false,
  }),
}));

vi.mock('./hooks', () => ({
  useOrgAgentAdmin: mockUseOrgAgentAdmin,
  useTenantSkillOptions: () => ({ skills: [], loading: false }),
  useTenantKnowledgeOptions: () => ({ knowledge: [], loading: false }),
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
import { SettingsDirtyBoundary } from '@/components/PersonalSettings/dirtyRegistry';
import {
  assembleScopeDescription,
  emptyFormValues,
  parseGateSlots,
  parseOrgAgentAdminList,
  type OrgAgentAdminRecord,
} from './types';
const API_TEMPLATES = [
  { name: '报价审核助手', allow: ['粘贴一份报价单让我审'] },
  { name: '客户情报分析师', allow: ['给公司名让我查'] },
  { name: '合同风险检测员', allow: ['粘贴一份合同让我审'] },
].map(({ name, allow }, index) => ({
  key: `template-${index}`,
  name,
  description: `${name}模板`,
  avatar: 'sales',
  icon: '✨',
  values: {
    ...emptyFormValues(),
    name,
    description: `${name}模板`,
    guardrailMode: 'shadow' as const,
    guardrailAllowExamples: allow,
    guardrailRejectExamples: ['闲聊'],
  },
}));

beforeEach(() => {
  mockAuthFetch.mockReset();
  mockUseOrgAgentAdmin.mockReset();
  mockUseOrgAgentAdmin.mockReturnValue({
    agents: [],
    dataIssues: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    loadConfiguration: mockLoadConfiguration,
    saveConfiguration: mockSaveConfiguration,
    updateStatus: mockUpdateStatus,
    uploadAvatar: mockUploadAvatar,
  });
  mockLoadConfiguration.mockReset();
  mockSaveConfiguration.mockReset().mockResolvedValue('org-new');
  mockUpdateStatus.mockReset().mockResolvedValue(undefined);
  mockUploadAvatar.mockReset();
  mockAuthFetch.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => url === '/api/models'
      ? {
          showGroupNames: true,
          groups: [{ id: 'group', name: '组织模型', models: [{ id: 'worker-model', name: 'Worker 专用模型' }] }],
        }
      : API_TEMPLATES,
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
    runtime: emptyFormValues().runtime,
    audience: { exposure: 'all', usernames: [] },
    guardrail: {
      mode: 'off',
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

describe('OrgAgentManager - 数据合同与异步隔离', () => {
  it('企业专家草稿会阻止设置导航', async () => {
    let requestNavigation!: (navigation: () => void) => void;
    render(
      <SettingsDirtyBoundary>
        {(controller) => {
          requestNavigation = controller.requestNavigation;
          return (
            <OrgAgentManager tenantId="kaiyan" />
          );
        }}
      </SettingsDirtyBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('如：产品选型助手'), { target: { value: '草稿专家' } });
    await act(async () => requestNavigation(vi.fn()));

    expect(await screen.findByRole('heading', { name: '有未保存的更改' })).toBeTruthy();
    expect(screen.getByText(/创建企业专家尚未保存/)).toBeTruthy();
  });

  it('隔离 audience 异常资源并显示安全错误状态', () => {
    mockUseOrgAgentAdmin.mockReturnValue({
      agents: [],
      dataIssues: [{ key: 'oa-bad', resourceId: 'oa-bad', message: '可见范围配置缺失或格式错误' }],
      loading: false,
      error: null,
      refresh: vi.fn(),
      loadConfiguration: mockLoadConfiguration,
      saveConfiguration: mockSaveConfiguration,
      updateStatus: mockUpdateStatus,
      uploadAvatar: mockUploadAvatar,
    });
    render(<OrgAgentManager tenantId="kaiyan" />);
    expect(screen.getByText('1 条资源数据不完整，已安全隐藏')).toBeTruthy();
    expect(screen.getByText(/现有资源的数据不完整/)).toBeTruthy();
    expect(screen.queryByText(/还没有企业专家/)).toBeNull();
  });

  it('组织切换后旧提交完成不会关闭或污染新组织弹窗', async () => {
    let resolveSave!: () => void;
    mockSaveConfiguration.mockImplementationOnce(() => new Promise<string>(resolve => {
      resolveSave = () => resolve('oa-old');
    }));
    const view = render(<OrgAgentManager tenantId="tenant-a" />);
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const firstDialog = await screen.findByRole('dialog');
    fireEvent.change(within(firstDialog).getByPlaceholderText('如：产品选型助手'), {
      target: { value: '旧组织专家' },
    });
    fireEvent.click(within(firstDialog).getByRole('button', { name: '创建' }));
    await waitFor(() => expect(mockSaveConfiguration).toHaveBeenCalledTimes(1));

    view.rerender(<OrgAgentManager tenantId="tenant-b" />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const secondDialog = await screen.findByRole('dialog');
    const secondName = within(secondDialog).getByPlaceholderText('如：产品选型助手') as HTMLInputElement;
    fireEvent.change(secondName, { target: { value: '新组织专家' } });
    await act(async () => { resolveSave(); });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(secondName.value).toBe('新组织专家');
  });

  it('编辑 deny_users 时以 everyone allow + 显式 deny 保存治理 Assignment', async () => {
    const agent = adminRecord({ audience: { exposure: 'deny_users', usernames: ['blocked-user'] } });
    const runtime = emptyFormValues().runtime;
    mockUseOrgAgentAdmin.mockReturnValue({
      agents: [agent],
      dataIssues: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      loadConfiguration: mockLoadConfiguration,
      saveConfiguration: mockSaveConfiguration,
      updateStatus: mockUpdateStatus,
      uploadAvatar: mockUploadAvatar,
    });
    mockLoadConfiguration.mockResolvedValue({
      resource: {
        agentId: agent.id,
        tenantId: agent.tenantId,
        kind: 'org_agent',
        ownerUserId: 'admin',
        status: 'enabled',
        currentVersionId: 'v1',
        revision: 1,
      },
      version: {
        versionId: 'v1',
        definition: {
          schemaVersion: 1,
          name: agent.name,
          description: agent.description,
          starterPrompts: [],
          instructions: agent.instructions,
          skills: [],
          knowledge: [],
          runtime,
          guardrail: agent.guardrail,
          source: 'governance',
        },
      },
      assignment: {
        version: 1,
        assignments: [
          { assigneeType: 'everyone', effect: 'allow', origin: 'direct' },
          { assigneeType: 'user', assigneeId: 'user-blocked', effect: 'deny', origin: 'direct' },
        ],
      },
    });

    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByTitle('编辑'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(
      (within(dialog).getByRole('radio', { name: '排除指定成员或部门' }) as HTMLInputElement).checked,
    ).toBe(true));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存全部配置' }));

    await waitFor(() => expect(mockSaveConfiguration).toHaveBeenCalledTimes(1));
    expect(mockSaveConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      assignments: [
        { assigneeType: 'everyone', effect: 'allow', origin: 'direct' },
        { assigneeType: 'user', assigneeId: 'user-blocked', effect: 'deny', origin: 'direct' },
      ],
    }));
  });

  it('重新打开时恢复 dispatcher 与 Worker 固定模型配置', async () => {
    const runtime = {
      ...emptyFormValues().runtime,
      executionMode: 'dispatcher' as const,
      workerModel: { strategy: 'fixed' as const, modelRef: 'group/worker-model' },
      capabilities: {
        ...emptyFormValues().runtime.capabilities,
        subagents: 'inherit' as const,
        backgroundTasks: 'inherit' as const,
      },
    };
    const agent = adminRecord({ runtime });
    mockUseOrgAgentAdmin.mockReturnValue({
      agents: [agent], dataIssues: [], loading: false, error: null, refresh: vi.fn(),
      loadConfiguration: mockLoadConfiguration, saveConfiguration: mockSaveConfiguration,
      updateStatus: mockUpdateStatus, uploadAvatar: mockUploadAvatar,
    });
    mockLoadConfiguration.mockResolvedValue({
      resource: { agentId: agent.id, tenantId: agent.tenantId, kind: 'org_agent', ownerUserId: 'admin', status: 'enabled', currentVersionId: 'v1', revision: 1 },
      version: { versionId: 'v1', definition: {
        schemaVersion: 1, name: agent.name, description: agent.description, starterPrompts: [],
        instructions: agent.instructions, skills: [], knowledge: [], runtime,
        guardrail: agent.guardrail, source: 'governance',
      } },
      assignment: { version: 1, assignments: [{ assigneeType: 'everyone', effect: 'allow', origin: 'direct' }] },
    });

    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByTitle('编辑'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(
      (within(dialog).getByRole('radio', { name: /前台调度器/ }) as HTMLInputElement).checked,
    ).toBe(true));
    expect(within(dialog).getByRole('combobox', { name: '企业专家 Worker 模型' }).textContent)
      .toContain('Worker 专用模型');
  });
});

describe('OrgAgentManager - 门禁填空 / 模板卡 / 试测按钮', () => {
  it('创建保存走治理 Version / Assignment，不再调用 legacy PATCH', async () => {
    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('如：产品选型助手'), { target: { value: '测试专家' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
    await waitFor(() => expect(mockSaveConfiguration).toHaveBeenCalledTimes(1));
    expect(mockSaveConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      configuration: null,
      enabled: true,
      assignments: [{ assigneeType: 'everyone', effect: 'allow', origin: 'direct' }],
      definition: expect.objectContaining({
        schemaVersion: 1,
        name: '测试专家',
        source: 'governance',
        runtime: expect.objectContaining({ schemaVersion: 1 }),
      }),
    }));
  });
  it('可切换为前台调度器并保存不可关闭的强制能力', async () => {
    render(<OrgAgentManager tenantId="kaiyan" />);
    fireEvent.click(screen.getByRole('button', { name: /创建企业专家/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('如：产品选型助手'), { target: { value: '前台助手' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /前台调度器/ }));
    const subagentsSwitch = within(dialog).getByRole('switch', { name: '子 Agent' });
    const backgroundTasksSwitch = within(dialog).getByRole('switch', { name: '后台任务' });
    expect(subagentsSwitch.getAttribute('aria-checked')).toBe('true');
    expect((subagentsSwitch as HTMLButtonElement).disabled).toBe(true);
    expect(backgroundTasksSwitch.getAttribute('aria-checked')).toBe('true');
    expect((backgroundTasksSwitch as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => expect(mockSaveConfiguration).toHaveBeenCalledOnce());
    expect(mockSaveConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        runtime: expect.objectContaining({
          executionMode: 'dispatcher',
          workerModel: { strategy: 'inherit' },
          capabilities: expect.objectContaining({ subagents: 'inherit', backgroundTasks: 'inherit' }),
        }),
      }),
    }));
  });

  it('渲染 3 张种子模板卡（报价审核 / 客户情报 / 合同风险）', async () => {
    render(<OrgAgentManager tenantId="kaiyan" tenantName="开沿科技" />);
    for (const template of API_TEMPLATES) {
      expect(await screen.findByText(template.name)).toBeTruthy();
    }
    const useButtons = screen.getAllByRole('button', { name: '使用此模板' });
    expect(useButtons.length).toBe(API_TEMPLATES.length);
  });

  it('后端模板接口失败时显式报错且不渲染伪造模板', async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: '模板服务不可用' }) });
    render(<OrgAgentManager tenantId="kaiyan" />);
    expect(await screen.findByText('加载企业专家模板失败：模板服务不可用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '使用此模板' })).toBeNull();
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
  it('接受 main 的 runtime 字段与合法 audience', () => {
    expect(parseOrgAgentAdminList([adminRecord()])).toMatchObject({
      agents: [{ id: 'oa-valid', audience: { exposure: 'all', usernames: [] } }],
      issues: [],
    });
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
    const result = parseOrgAgentAdminList([{ ...adminRecord(), id: `oa-${_label}`, audience }]);
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

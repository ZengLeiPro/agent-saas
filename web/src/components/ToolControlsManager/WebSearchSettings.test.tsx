import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchToolControlsConfig,
  updateToolControlsConfig,
  updateSingleTool,
  type ToolControlsAdminResponse,
} from '@agent/shared';
import { ToolControlsManager, buildWebToolsPayload } from './index';

const auth = vi.hoisted(() => ({ platformReadOnly: false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/shared')>()),
  fetchToolControlsConfig: vi.fn(),
  updateToolControlsConfig: vi.fn(),
  updateSingleTool: vi.fn(),
}));

const initial: ToolControlsAdminResponse = {
  revision: 'revision-1',
  toolControls: {},
  effectiveWebTools: ['WebSearch'],
  tools: [
    {
      id: 'WebSearch',
      name: 'WebSearch',
      displayName: '网页搜索',
      label: '网页搜索',
      category: 'web',
      enabled: true,
      description: '搜索网页',
      effectiveDescription: '搜索网页',
      inputSchema: {},
      risk: 'safe',
      approvalMode: 'never',
      auditCategory: 'web',
    },
  ],
  webTools: {
    search: {
      provider: 'volcengine',
      apiKeyRef: 'vault-main',
      hasApiKey: true,
      timeoutMs: 8000,
      global: {
        provider: 'tavily',
        apiKeyRef: 'vault-global',
        searchDepth: 'advanced',
        timeoutMs: 9000,
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.platformReadOnly = false;
  vi.mocked(fetchToolControlsConfig).mockResolvedValue(structuredClone(initial));
});

describe('WebSearch 管理详情', () => {
  it('详情页编辑两源后保存，携带版本与既有境外档位，保存后清空密码', async () => {
    const user = userEvent.setup();
    vi.mocked(updateToolControlsConfig).mockResolvedValue({ ...initial, revision: 'revision-2' });
    render(<ToolControlsManager />);
    await user.click(await screen.findByRole('button', { name: /WebSearch 开启/ }));
    const domestic = within(screen.getByRole('group', { name: '国内搜索源' }));
    await user.type(domestic.getByLabelText('API Key'), 'new-plan-key');
    const wait = domestic.getByLabelText('最长排队等待（毫秒）');
    await user.type(wait, '7000');
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(await screen.findByText('已保存并热生效')).toBeTruthy();
    expect(updateToolControlsConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 'revision-1',
        webTools: expect.objectContaining({
          search: expect.objectContaining({
            provider: 'volcengine',
            apiKey: 'new-plan-key',
            timeoutMs: 8000,
            maxWaitTimeMs: 7000,
            global: expect.objectContaining({
              provider: 'tavily',
              apiKeyRef: 'vault-global',
              searchDepth: 'advanced',
              timeoutMs: 9000,
            }),
          }),
        }),
      }),
    );
    expect((domestic.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
  });

  it('保存描述后搜索草稿与密钥仍在，后续用新版本提交且不注入结果上限', async () => {
    const user = userEvent.setup();
    vi.mocked(updateSingleTool).mockResolvedValue({
      ...initial,
      revision: 'revision-2',
      tools: initial.tools.map((tool) => ({
        ...tool,
        descriptionOverride: { mode: 'append', text: '补充描述' },
      })),
    });
    vi.mocked(updateToolControlsConfig).mockResolvedValue({ ...initial, revision: 'revision-3' });
    render(<ToolControlsManager />);
    await user.click(await screen.findByRole('button', { name: /WebSearch 开启/ }));
    const key = within(screen.getByRole('group', { name: '国内搜索源' })).getByLabelText('API Key');
    await user.type(key, 'pending-plan-key');
    await user.type(screen.getByPlaceholderText(/追加内容，比如/), '补充描述');
    await user.click(screen.getByRole('button', { name: '保存覆盖' }));
    await screen.findByText('已保存并热生效');
    expect((key as HTMLInputElement).value).toBe('pending-plan-key');
    expect(screen.getByText('有未保存更改')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    const submitted = vi.mocked(updateToolControlsConfig).mock.calls[0][0];
    expect(submitted.expectedRevision).toBe('revision-2');
    expect(submitted.webTools?.search?.apiKey).toBe('pending-plan-key');
    expect(submitted.webTools?.search?.maxResults).toBeUndefined();
    expect(submitted.toolControls?.tools?.WebSearch.descriptionOverride?.text).toBe('补充描述');
  });

  it('关闭境外源提交显式 null，失败留在详情展示错误', async () => {
    const user = userEvent.setup();
    vi.mocked(updateToolControlsConfig).mockRejectedValue(new Error('版本已更新，请刷新'));
    render(<ToolControlsManager />);
    await user.click(await screen.findByRole('button', { name: /WebSearch 开启/ }));
    await user.click(screen.getByLabelText('独立配置境外搜索源'));
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect((await screen.findByRole('alert')).textContent).toContain('版本已更新');
    expect(updateToolControlsConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        webTools: expect.objectContaining({ search: expect.objectContaining({ global: null }) }),
      }),
    );
  });

  it('参数保存期间禁止返回列表、再次保存与编辑搜索源', async () => {
    const user = userEvent.setup();
    let resolve!: (response: ToolControlsAdminResponse) => void;
    vi.mocked(updateToolControlsConfig).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<ToolControlsManager />);
    await user.click(await screen.findByRole('button', { name: /WebSearch 开启/ }));
    const key = within(screen.getByRole('group', { name: '国内搜索源' })).getByLabelText('API Key');
    await user.type(key, 'pending-plan-key');
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(
      (screen.getByRole('button', { name: '返回工具列表' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(key.matches(':disabled')).toBe(true);
    resolve({ ...initial, revision: 'revision-2' });
    await screen.findByText('已保存并热生效');
    expect(
      (screen.getByRole('button', { name: '返回工具列表' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('只读管理员不能输入凭据或保存', async () => {
    auth.platformReadOnly = true;
    render(<ToolControlsManager />);
    await userEvent.click(await screen.findByRole('button', { name: /WebSearch 开启/ }));
    expect(screen.getAllByLabelText('API Key')[0].matches(':disabled')).toBe(true);
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('保留零省略语义与每个源的专项参数，校验境外排队上限', () => {
    const payload = buildWebToolsPayload(
      {
        search: {
          provider: 'zhipu',
          searchEngine: 'search_pro',
          global: {
            provider: 'volcengine',
            enableWaiting: false,
            maxWaitTimeMs: 10000,
          },
        },
      },
      {},
      '',
      '',
      '',
      '',
    );
    expect(payload?.search).toMatchObject({
      searchEngine: 'search_pro',
      global: { enableWaiting: false, maxWaitTimeMs: 10000 },
    });
    expect(payload?.search?.timeoutMs).toBeUndefined();
    expect(payload?.search?.maxResults).toBeUndefined();
    expect(() =>
      buildWebToolsPayload({ search: { global: { maxWaitTimeMs: 10001 } } }, {}, '', '', '', ''),
    ).toThrow('排队等待');
  });
});

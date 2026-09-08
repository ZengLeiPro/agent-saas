import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigWritePolicy, type ConfigWritePolicy } from '@agent/shared/configWritePolicy';
import { authFetch } from '@/lib/authFetch';
import { ModelManager } from './index';

const auth = vi.hoisted(() => ({ platformReadOnly: false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));
vi.mock('@/lib/refreshBus', () => ({ refreshAll: vi.fn(async () => undefined) }));
vi.mock('./CodexSubscriptionCard', () => ({
  CodexSubscriptionCard: ({ readOnly }: { readOnly: boolean }) => (
    <button disabled={readOnly}>独立订阅授权</button>
  ),
}));

const models = {
  default: 'main/gpt',
  allowCrossGroupSwitch: true,
  groups: [
    {
      id: 'main',
      name: '主分组',
      models: [
        { id: 'gpt', name: 'GPT', value: 'gpt-5' },
        { id: 'mini', name: 'Mini', value: 'mini' },
      ],
    },
  ],
};
let policy: ConfigWritePolicy | undefined;
let denySave: boolean;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function view() {
  return {
    revision: 'rev-1',
    models,
    memoryIndex: null,
    writePolicy: policy,
    titleGenerator: { model: 'main/gpt', fallbackModels: [] },
    titleSystemPrompt: { content: '标题', defaultContent: '标题', overridden: false },
    publicModelList: models,
  };
}
function putCalls() {
  return vi
    .mocked(authFetch)
    .mock.calls.filter(([path, init]) => path === '/api/admin/models' && init?.method === 'PUT');
}

beforeEach(() => {
  auth.platformReadOnly = false;
  policy = getConfigWritePolicy('production');
  denySave = false;
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      if (denySave)
        return json(
          {
            error: '生产配置不能直接在线保存，请通过受控配置发布流程变更',
            code: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED',
          },
          409,
        );
      const payload = JSON.parse(String(init.body));
      return json({ ...view(), models: payload.models, revision: 'rev-2' });
    }
    return json(view());
  });
});

describe('ModelManager write capability', () => {
  it('shows the production restriction BEFORE editing and keeps navigation usable', async () => {
    const user = userEvent.setup();
    render(<ModelManager />);
    expect(await screen.findByText(/当前部署尚未提供生产配置在线发布能力/)).toBeTruthy();
    const save = screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(putCalls()).toHaveLength(0);
    expect(
      (screen.getByRole('button', { name: '新增模型分组' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Subscription authorization is a separate API, not part of model-config saving.
    expect(
      (screen.getByRole('button', { name: '独立订阅授权' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: /GPT gpt-5/ }));
    expect(screen.getByDisplayValue('gpt-5').matches(':disabled')).toBe(true);
    const sort = screen.getByRole('button', { name: '调整模型 GPT 的顺序' }) as HTMLButtonElement;
    expect(sort.disabled).toBe(true);
    expect(sort.draggable).toBe(false);
    await user.click(screen.getByRole('button', { name: '主分组 main · 2 个模型' }));
    expect(screen.getByDisplayValue('主分组').matches(':disabled')).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });

  it('does not assume a legacy or unknown backend permits writes', async () => {
    policy = undefined;
    render(<ModelManager />);
    expect(await screen.findByText(/尚未取得服务端配置写入策略/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(putCalls()).toHaveLength(0);
  });

  it('keeps the existing staging save path', async () => {
    policy = getConfigWritePolicy('staging');
    const user = userEvent.setup();
    render(<ModelManager />);
    expect(await screen.findByText(/当前为测试环境/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(putCalls()).toHaveLength(1);
    expect(JSON.parse(String(putCalls()[0]?.[1]?.body)).expectedRevision).toBe('rev-1');
  });

  it('an account read-only restriction wins over writable server policy', async () => {
    auth.platformReadOnly = true;
    policy = getConfigWritePolicy('staging');
    render(<ModelManager />);
    expect(await screen.findByText(/当前账号只有查看权限/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: '独立订阅授权' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a typed production denial withdraws permission without erasing the unsaved draft', async () => {
    policy = getConfigWritePolicy('staging');
    denySave = true;
    const user = userEvent.setup();
    render(<ModelManager />);
    await screen.findByText(/当前为测试环境/);
    await user.click(screen.getByRole('button', { name: /GPT gpt-5/ }));
    fireEvent.change(screen.getByDisplayValue('gpt-5'), {
      target: { value: 'unsaved-model-value' },
    });
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(await screen.findByText(/当前部署尚未提供生产配置在线发布能力/)).toBeTruthy();
    expect(screen.getByDisplayValue('unsaved-model-value')).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(putCalls()).toHaveLength(1);
  });

  it('a failed refresh withdraws a previously writable capability', async () => {
    policy = getConfigWritePolicy('staging');
    const user = userEvent.setup();
    render(<ModelManager />);
    await screen.findByText(/当前为测试环境/);
    vi.mocked(authFetch).mockResolvedValueOnce(json({ error: '读取失败' }, 503));
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(screen.getByText(/尚未取得服务端配置写入策略/)).toBeTruthy();
    });
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(putCalls()).toHaveLength(0);
  });
});

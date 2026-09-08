import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigWritePolicy } from '@agent/shared/configWritePolicy';
import { authFetch } from '@/lib/authFetch';
import { ModelManager } from './index';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ platformReadOnly: false }) }));
vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));
vi.mock('@/lib/refreshBus', () => ({ refreshAll: vi.fn(async () => undefined) }));
vi.mock('./CodexSubscriptionCard', () => ({ CodexSubscriptionCard: () => null }));
const models = { default: 'main/gpt', allowCrossGroupSwitch: true,
  groups: [{ id: 'main', name: 'Main', models: [{ id: 'gpt', name: 'GPT', value: 'original-model' }] }] };
const view = { revision: 'current-production-revision', models, memoryIndex: null,
  writePolicy: getConfigWritePolicy('production', true),
  titleGenerator: { model: 'main/gpt', fallbackModels: [] },
  titleSystemPrompt: { content: '标题', defaultContent: '标题', overridden: false }, publicModelList: models };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const putCalls = () => vi.mocked(authFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockImplementation(async (_path, init) => init?.method === 'PUT'
    ? json({ ...view, revision: 'new-production-revision', models: JSON.parse(String(init.body)).models }) : json(view));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('production ModelManager save', () => {
  it('saves an editable production configuration with exact-revision confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<ModelManager />);
    expect(await screen.findByText(/当前为生产环境/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /GPT original-model/ }));
    fireEvent.change(screen.getByDisplayValue('original-model'), { target: { value: 'changed-model' } });
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(confirm).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(putCalls()[0]?.[1]?.body));
    expect(payload.productionConfirmation).toBe(view.revision);
    expect(payload.expectedRevision).toBe(view.revision);
    expect(payload.models.groups[0].models[0].value).toBe('changed-model');
  });

  it('cancelling confirmation keeps the draft and performs no HTTP write', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    render(<ModelManager />);
    await screen.findByText(/当前为生产环境/);
    await user.click(screen.getByRole('button', { name: /GPT original-model/ }));
    fireEvent.change(screen.getByDisplayValue('original-model'), { target: { value: 'draft-model' } });
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(putCalls()).toHaveLength(0);
    expect(screen.getByDisplayValue('draft-model')).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('does not show saved or permit a duplicate write before both-runtime confirmation returns', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish!: (response: Response) => void;
    vi.mocked(authFetch).mockImplementation(async (_path, init) => init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { finish = resolve; }) : json(view));
    const user = userEvent.setup();
    render(<ModelManager />);
    await screen.findByText(/当前为生产环境/);
    const button = screen.getByRole('button', { name: '保存并生效' });
    await user.click(button);
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(button.matches(':disabled')).toBe(true);
    expect(screen.queryByText('已保存')).toBeNull();
    await user.click(button);
    expect(putCalls()).toHaveLength(1);
    finish(json({ ...view, revision: 'confirmed-revision' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('a committed-but-unconfirmed error is never presented as success or automatically retried', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(authFetch).mockImplementation(async (_path, init) => init?.method === 'PUT'
      ? json({ code: 'CONFIG_MUTATION_COMMITTED', error: '配置已提交，但最终生效确认未完成，请刷新确认' }, 500) : json(view));
    const user = userEvent.setup();
    render(<ModelManager />);
    await screen.findByText(/当前为生产环境/);
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(await screen.findByText(/最终生效确认未完成/)).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
    expect(putCalls()).toHaveLength(1);
  });
});

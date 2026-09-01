import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeWorkflowLibrary,
  makeWorkflowScenario,
} from '@/components/scenarios/workflowTestFixtures';
import WorkflowDisplaySettingsPage from './WorkflowDisplaySettingsPage';

const workflows = [
  makeWorkflowScenario('workflow-a', { title: '客户推进分析' }),
  makeWorkflowScenario('workflow-b', { title: '经营风险分析' }),
  makeWorkflowScenario('workflow-c', { title: '拜访准备' }),
];
const library = makeWorkflowLibrary(workflows);
const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock('@/lib/authFetch', () => ({ authFetch: mocks.authFetch }));
vi.mock('@/components/scenarios/useScenarioLibrary', () => ({
  useScenarioLibrary: () => ({ workflowLibrary: library, loading: false, error: null }),
}));

const policiesResponse = {
  tenantId: 'tenant-a',
  policies: [],
  positions: [{ id: '销售', label: '销售', memberCount: 2 }],
  members: [
    { id: 'user-a', username: 'alice', displayName: '爱丽丝', position: '销售', disabled: false },
  ],
};

describe('WorkflowDisplaySettingsPage', () => {
  beforeEach(() => {
    mocks.authFetch.mockReset();
    mocks.authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const input = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...input, tenantId: 'tenant-a', subjectId: '销售', revision: 1 }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => policiesResponse } as Response;
    });
  });

  it('提供组织、岗位、成员三级入口，并按岗位保存有序工作流', async () => {
    render(<WorkflowDisplaySettingsPage tenantId="tenant-a" />);

    expect(await screen.findByRole('button', { name: /组织默认/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '销售 2 人' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /爱丽丝/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '销售 2 人' }));
    fireEvent.click(screen.getByRole('button', { name: '创建本层覆盖' }));
    fireEvent.change(screen.getByLabelText('显示数量'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() =>
      expect(mocks.authFetch).toHaveBeenCalledWith(
        '/api/scenarios/display-policies',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const saveCall = mocks.authFetch.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      tenantId: 'tenant-a',
      scope: 'position',
      subjectLabel: '销售',
      displayCount: 2,
      workflowIds: ['workflow-a', 'workflow-b', 'workflow-c'],
      expectedRevision: 0,
    });
  });
});

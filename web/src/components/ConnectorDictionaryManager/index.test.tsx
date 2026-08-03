/**
 * 平台管理「连接器映射」页。
 *
 * 重点不在渲染像素，在**文本 ↔ 词典的双向转换**：动词行末段决定一个动作
 * 是不是写操作，而写操作会盖回执章。这里转错一位，客户就会在一次查询上
 * 看到「AI 动了你家系统」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  ConnectorDictionaryManager,
  linesToList,
  linesToMap,
  linesToVerbs,
  mapToLines,
  verbsToLines,
} from './index';

const fetchConnectorDictionary = vi.fn();
const saveConnectorEntry = vi.fn();
const deleteConnectorEntry = vi.fn();
const resetConnectorDictionary = vi.fn();

vi.mock('@agent/shared', () => ({
  fetchConnectorDictionary: (...args: unknown[]) => fetchConnectorDictionary(...args),
  saveConnectorEntry: (...args: unknown[]) => saveConnectorEntry(...args),
  deleteConnectorEntry: (...args: unknown[]) => deleteConnectorEntry(...args),
  resetConnectorDictionary: (...args: unknown[]) => resetConnectorDictionary(...args),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ platformReadOnly: false }),
}));

const DWS = {
  binary: 'dws',
  systemName: '钉钉',
  enabled: true,
  modules: { todo: '待办', approval: '审批' },
  actionVerbs: { create: { name: '创建', write: true }, list: { name: '查询', write: false } },
  excludePatterns: ['--help', '-h'],
  urlWhitelist: ['alidocs.dingtalk.com'],
  updatedAt: '2026-08-03T10:00:00.000Z',
  updatedBy: 'admin',
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchConnectorDictionary.mockResolvedValue({ entries: [DWS], builtin: [DWS] });
  saveConnectorEntry.mockResolvedValue({ entries: [DWS], builtin: [DWS] });
});

describe('词典 ↔ 文本转换', () => {
  it('模块表按「键 = 值」往返', () => {
    expect(mapToLines({ todo: '待办' })).toBe('todo = 待办');
    expect(linesToMap('todo = 待办\n\napproval = 审批')).toEqual({ todo: '待办', approval: '审批' });
  });

  it('动词行末段决定读写；缺省按「读」——写操作会盖回执章，宁可漏盖不可错盖', () => {
    expect(verbsToLines(DWS.actionVerbs)).toBe('create = 创建 | 写\nlist = 查询 | 读');
    expect(linesToVerbs('create = 创建 | 写')).toEqual({ create: { name: '创建', write: true } });
    expect(linesToVerbs('list = 查询 | 读')).toEqual({ list: { name: '查询', write: false } });
    expect(linesToVerbs('list = 查询')).toEqual({ list: { name: '查询', write: false } });
  });

  it('残缺行被丢弃而不是产出半截条目', () => {
    expect(linesToMap('todo\n= 待办\n  ')).toEqual({});
    expect(linesToVerbs('create\n = 创建')).toEqual({});
    expect(linesToList('--help\n\n  -h  ')).toEqual(['--help', '-h']);
  });
});

describe('ConnectorDictionaryManager', () => {
  it('加载后展示连接器列表与当前词典内容', async () => {
    render(<ConnectorDictionaryManager />);
    await waitFor(() => expect(screen.getByText('钉钉')).toBeTruthy());
    expect((screen.getByLabelText('系统名') as HTMLInputElement).value).toBe('钉钉');
    expect((screen.getByLabelText('模块映射') as HTMLTextAreaElement).value).toContain('todo = 待办');
    expect((screen.getByLabelText('动作动词') as HTMLTextAreaElement).value).toContain('create = 创建 | 写');
    expect((screen.getByLabelText('排除规则') as HTMLTextAreaElement).value).toContain('--help');
  });

  it('保存把文本还原成结构化词典提交', async () => {
    render(<ConnectorDictionaryManager />);
    await waitFor(() => expect(screen.getByLabelText('系统名')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('模块映射'), { target: { value: 'todo = 任务中心' } });
    fireEvent.change(screen.getByLabelText('动作动词'), { target: { value: 'create = 新建 | 写\nlist = 查询 | 读' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(saveConnectorEntry).toHaveBeenCalledTimes(1));
    expect(saveConnectorEntry).toHaveBeenCalledWith(expect.objectContaining({
      binary: 'dws',
      systemName: '钉钉',
      modules: { todo: '任务中心' },
      actionVerbs: { create: { name: '新建', write: true }, list: { name: '查询', write: false } },
    }));
    await waitFor(() => expect(screen.getByText(/已保存并生效/)).toBeTruthy());
  });

  it('未改动时保存按钮不可点——避免无意义的写与审计噪声', async () => {
    render(<ConnectorDictionaryManager />);
    await waitFor(() => expect(screen.getByLabelText('系统名')).toBeTruthy());
    expect((screen.getByText('保存').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('停用开关进入提交体', async () => {
    render(<ConnectorDictionaryManager />);
    await waitFor(() => expect(screen.getByLabelText('启用该连接器')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('启用该连接器'));
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(saveConnectorEntry).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
  });

  it('接口报错时把原因显示出来，不静默吞掉', async () => {
    saveConnectorEntry.mockRejectedValueOnce(new Error('urlWhitelist 项非法：*'));
    render(<ConnectorDictionaryManager />);
    await waitFor(() => expect(screen.getByLabelText('链接域名白名单')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('链接域名白名单'), { target: { value: '*' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText(/urlWhitelist 项非法/)).toBeTruthy());
  });

  it('恢复内置调用 reset 接口', async () => {
    resetConnectorDictionary.mockResolvedValue({ entries: [DWS], builtin: [DWS] });
    render(<ConnectorDictionaryManager />);
    await waitFor(() => expect(screen.getByText('恢复内置')).toBeTruthy());
    fireEvent.click(screen.getByText('恢复内置'));
    await waitFor(() => expect(resetConnectorDictionary).toHaveBeenCalledTimes(1));
  });
});

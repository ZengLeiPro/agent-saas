import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kyAppRequest } from '@/lib/kyAppManagementApi';
import { useManagementResource, ResourceState } from './ManagementResource';
vi.mock('@/lib/kyAppManagementApi', () => ({ kyAppRequest: vi.fn() }));
function Probe({ path }: { path: string }) {
  const result = useManagementResource<{ name: string }>(path);
  return result.data ? (
    <span>{result.data.name}</span>
  ) : (
    <ResourceState error={result.error} retry={result.reload} />
  );
}
beforeEach(() => vi.resetAllMocks());
describe('组织请求隔离', () => {
  it('旧组织迟到响应不能覆盖新组织，离开时取消请求', async () => {
    let resolveA!: (value: unknown) => void;
    vi.mocked(kyAppRequest)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce({ name: '组织 B' });
    const { rerender, unmount } = render(<Probe path="/installations?tenantId=a" />);
    const signal = vi.mocked(kyAppRequest).mock.calls[0]![1]!.signal!;
    rerender(<Probe path="/installations?tenantId=b" />);
    expect(signal.aborted).toBe(true);
    expect(await screen.findByText('组织 B')).toBeTruthy();
    await act(async () => resolveA({ name: '组织 A' }));
    expect(screen.queryByText('组织 A')).toBeNull();
    unmount();
    expect(vi.mocked(kyAppRequest).mock.calls[1]![1]!.signal!.aborted).toBe(true);
  });
  it('错误可重试', async () => {
    vi.mocked(kyAppRequest)
      .mockRejectedValueOnce(new Error('读取失败'))
      .mockResolvedValueOnce({ name: '已恢复' });
    render(<Probe path="/systems" />);
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByText('已恢复')).toBeTruthy();
  });
});

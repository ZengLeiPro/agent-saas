import { describe, expect, it, vi } from 'vitest';
import {
  assertAuthRequestBoundary,
  captureAuthRequestBoundary,
  StaleAuthRequestError,
} from './authRequestFence';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('Auth request generation and service origin fence', () => {
  it('服务 A 的慢响应在切换到 B 后不能进入 commit', async () => {
    let current = { generation: 4, apiOrigin: 'https://a.example.com' };
    const fence = captureAuthRequestBoundary(current.generation, current.apiOrigin);
    const response = deferred<{ token: string }>();
    const commit = vi.fn();

    const request = (async () => {
      const value = await response.promise;
      assertAuthRequestBoundary(fence, current.generation, current.apiOrigin);
      commit(value);
    })();

    current = { generation: 5, apiOrigin: 'https://b.example.com' };
    response.resolve({ token: 'TOKEN_FROM_A' });

    await expect(request).rejects.toBeInstanceOf(StaleAuthRequestError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('同一 generation 与 origin 的响应可以提交', () => {
    const fence = captureAuthRequestBoundary(7, 'https://service.example.com');
    expect(() => assertAuthRequestBoundary(fence, 7, 'https://service.example.com')).not.toThrow();
  });
});

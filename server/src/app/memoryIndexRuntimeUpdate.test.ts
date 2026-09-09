import { describe, expect, it, vi } from 'vitest';
import { MemoryIndexService } from '../memory/index/service.js';
import type { MemoryIndexConfig } from '../memory/index/types.js';
import { createMemoryIndexRuntimeUpdatePreparer } from './memoryIndexRuntimeUpdate.js';

function fixture() {
  const previous = new MemoryIndexService({} as MemoryIndexConfig);
  const next = new MemoryIndexService({} as MemoryIndexConfig);
  const current = { current: previous as MemoryIndexService | null };
  const retained = new Set<MemoryIndexService>([previous]);
  const publish = vi.fn();
  const create = vi.fn(async () => next as MemoryIndexService | null);
  const warn = vi.fn();
  const prepare = createMemoryIndexRuntimeUpdatePreparer({
    current,
    retained,
    publish,
    create,
    warn,
  });
  return { previous, next, current, retained, publish, create, prepare };
}

describe('memory index runtime transaction', () => {
  it('does not swap or retire the current service during candidate preparation', async () => {
    const f = fixture();
    const retire = vi.spyOn(f.previous, 'retireAll');
    await f.prepare(undefined);
    expect(f.current.current).toBe(f.previous);
    expect(f.publish).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });
  it('commits the candidate and retires old watchers only after the full transaction succeeds', async () => {
    const f = fixture();
    const retire = vi.spyOn(f.previous, 'retireAll');
    const close = vi.spyOn(f.previous, 'closeAll');
    const transaction = await f.prepare(undefined);
    transaction.commit();
    expect(f.current.current).toBe(f.next);
    expect(retire).not.toHaveBeenCalled();
    transaction.complete();
    expect(retire).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(f.retained.has(f.previous)).toBe(true);
  });
  it('restores the exact old service when a later configuration commit step fails', async () => {
    const f = fixture();
    const previousRetire = vi.spyOn(f.previous, 'retireAll');
    const candidateRetire = vi.spyOn(f.next, 'retireAll');
    const transaction = await f.prepare(undefined);
    transaction.commit();
    transaction.rollback();
    transaction.dispose();
    expect(f.current.current).toBe(f.previous);
    expect(previousRetire).not.toHaveBeenCalled();
    expect(candidateRetire).toHaveBeenCalledOnce();
    expect(f.retained.has(f.next)).toBe(true);
  });
  it('a failed credential preparation leaves the old service untouched', async () => {
    const f = fixture();
    f.create.mockRejectedValue(new Error('credential resolution failed'));
    await expect(f.prepare(undefined)).rejects.toThrow('credential resolution failed');
    expect(f.current.current).toBe(f.previous);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('supports disabling memory indexing without prematurely closing inflight work', async () => {
    const f = fixture();
    f.create.mockResolvedValue(null);
    const close = vi.spyOn(f.previous, 'closeAll');
    const transaction = await f.prepare(undefined);
    transaction.commit();
    transaction.complete();
    expect(f.current.current).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
});

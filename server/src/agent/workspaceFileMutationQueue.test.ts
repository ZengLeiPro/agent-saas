import { describe, expect, it } from 'vitest';

import { withWorkspaceFileMutationQueue } from './workspaceFileMutationQueue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('withWorkspaceFileMutationQueue', () => {
  it('serializes mutations targeting the same normalized path', async () => {
    const gate = deferred();
    const firstStarted = deferred();
    const order: string[] = [];
    const first = withWorkspaceFileMutationQueue('/workspace/root', 'src/../a.txt', async () => {
      order.push('first:start');
      firstStarted.resolve();
      await gate.promise;
      order.push('first:end');
    });
    const second = withWorkspaceFileMutationQueue('/workspace/root', 'a.txt', async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await firstStarted.promise;
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('allows a nested mutation of the same path without deadlocking', async () => {
    const order: string[] = [];
    await withWorkspaceFileMutationQueue('/workspace/root', 'a.txt', async () => {
      order.push('outer:start');
      await withWorkspaceFileMutationQueue('/workspace/root', './a.txt', async () => {
        order.push('inner');
      });
      order.push('outer:end');
    });
    expect(order).toEqual(['outer:start', 'inner', 'outer:end']);
  });

  it('does not serialize different paths', async () => {
    const gate = deferred();
    const firstStarted = deferred();
    const order: string[] = [];
    const first = withWorkspaceFileMutationQueue('/workspace/root', 'a.txt', async () => {
      order.push('a');
      firstStarted.resolve();
      await gate.promise;
    });
    const second = withWorkspaceFileMutationQueue('/workspace/root', 'b.txt', async () => {
      order.push('b');
    });

    await Promise.all([firstStarted.promise, second]);
    expect(order).toEqual(['a', 'b']);
    gate.resolve();
    await first;
  });
});

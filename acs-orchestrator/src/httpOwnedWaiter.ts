import type { ServerResponse } from 'node:http';

/** Losing an HTTP waiter does not cancel the shared operation it joined. */
export async function withDisconnectedWaiter<T>(res: ServerResponse, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', close);
  try {
    if (res.destroyed) controller.abort();
    return await work(controller.signal);
  } finally { res.removeListener('close', close); }
}

type RefreshFn = () => Promise<void>;
const registry = new Map<string, RefreshFn>();

export function registerRefresh(key: string, fn: RefreshFn) {
  registry.set(key, fn);
}

export function unregisterRefresh(key: string) {
  registry.delete(key);
}

export async function refreshAll(): Promise<void> {
  await Promise.all([...registry.values()].map((fn) => fn()));
}

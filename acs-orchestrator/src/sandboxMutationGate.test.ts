import { describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import { OwnedOperations } from './ownedOperations.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import { SandboxOwnershipReaders } from './sandboxOwnershipReaders.js';
import { OwnershipBlockedError, writableScope, type WritableScope } from './ownershipState.js';

vi.mock('./sandboxInventoryReader.js', () => ({ readManagedSandboxes: vi.fn(async () => inventory) }));
let inventory: unknown[] = [];

const config = { namespace: 'unit', pvcName: 'pvc' } as AcsOrchestratorConfig;
// 同一用户共享 workspace 目录，两个并发会话各自一个 sandbox。
const MOUNT = 'workspaces/kaiyan/user';
const WORKSPACE = 'ws_kaiyan__user';
// 用 writableScope 生成 owner 作用域，保证 storageId 与 assertMutation 内部 scopeForSandbox 一致，
// 否则 scopesOverlap 的 storageId 短路会让旧代码也「碰巧」放行、失去反向证明力。
const scopeA: WritableScope = writableScope(config, {
  name: 'as-user--a', workspaceId: WORKSPACE, sessionId: 'sess-a', sandboxScopeId: 'scope-a', mountSubPath: MOUNT });
const scopeB: WritableScope = writableScope(config, {
  name: 'as-user--b', workspaceId: WORKSPACE, sessionId: 'sess-b', sandboxScopeId: 'scope-b', mountSubPath: MOUNT });
const journal = { read: vi.fn(async () => []) } as unknown as OwnershipJournal;

function readers(operations: OwnedOperations) {
  return new SandboxOwnershipReaders(config, {} as Kubectl, operations, journal, null);
}
function sandbox(name: string, sessionId: string, leases: unknown[] = []) {
  return { name, workspaceId: WORKSPACE, sessionId, sandboxScopeId: `scope-${sessionId}`,
    mountSubPath: MOUNT, activeInvocationLeases: leases };
}

describe('assertMutation 删除单个 sandbox 只受该 sandbox 自身约束', () => {
  it('兄弟会话在同一目录持有 provision/ensure owner 时，仍可删除本 sandbox（deleteResourceDrift 复现）', async () => {
    const operations = new OwnedOperations();
    // 兄弟会话 B 正在 provision（未终态、同目录）
    await operations.begin({ kind: 'provision', invocationId: 'provision:b', attemptId: 'provision:b:1', scope: scopeB });
    inventory = [sandbox('as-user--a', 'sess-a'), sandbox('as-user--b', 'sess-b')];
    // 删除 A 自己（drift 重建）不应被 B 的 owner 阻断
    await expect(readers(operations).assertMutation('as-user--a')).resolves.toBeUndefined();
  });

  it('兄弟 sandbox 有活跃 lease 时，不阻断删除本 sandbox', async () => {
    const operations = new OwnedOperations();
    const lease = { annotationKey: 'k', raw: '{}', invocationKey: 'b-attempt', state: 'executing', malformed: false };
    inventory = [sandbox('as-user--a', 'sess-a'), sandbox('as-user--b', 'sess-b', [lease])];
    await expect(readers(operations).assertMutation('as-user--a')).resolves.toBeUndefined();
  });

  it('被删 sandbox 自身有未终态 owner 时仍阻断', async () => {
    const operations = new OwnedOperations();
    await operations.begin({ kind: 'ensure', invocationId: 'ensure:a', attemptId: 'ensure:a:1', scope: scopeA });
    inventory = [sandbox('as-user--a', 'sess-a')];
    await expect(readers(operations).assertMutation('as-user--a')).rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('被删 sandbox 自身有活跃 lease 时仍阻断（不能删正在执行的 Pod）', async () => {
    const operations = new OwnedOperations();
    const lease = { annotationKey: 'k', raw: '{}', invocationKey: 'a-attempt', state: 'executing', malformed: false };
    inventory = [sandbox('as-user--a', 'sess-a', [lease])];
    await expect(readers(operations).assertMutation('as-user--a')).rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('目标 sandbox 不在库存中则直接放行（由 UID/resourceVersion 门禁独立复核）', async () => {
    const operations = new OwnedOperations();
    inventory = [sandbox('as-user--b', 'sess-b')];
    await expect(readers(operations).assertMutation('as-user--a')).resolves.toBeUndefined();
  });
});

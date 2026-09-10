import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import { createOwnedExecutionRuntime } from './ownedExecutionRuntime.js';
import { OwnershipJournal } from './ownershipJournal.js';
import { Provisioner } from './provision.js';
import type { WorkspaceRecipe } from './protocol.js';
import { SandboxManager } from './sandboxManager.js';

vi.mock('./remoteOwnershipReconciler.js', () => ({
  reconcileRemoteOwnership: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('owned execution runtime', () => {
  it('joins an in-flight warmup ensure before reserving the provision owner', async () => {
    let finishEnsure!: () => void;
    const ensurePending = new Promise<void>((resolve) => {
      finishEnsure = resolve;
    });
    const ensure = vi
      .spyOn(SandboxManager.prototype, 'ensureRunning')
      .mockImplementation(async function (this: SandboxManager, input) {
        await ensurePending;
        return this.ref(input);
      });
    const provision = vi.spyOn(Provisioner.prototype, 'provision').mockResolvedValue({
      status: 'ok',
      logs: [],
      metadata: {},
    });
    vi.spyOn(OwnershipJournal.prototype, 'reserve').mockImplementation(async (record) => record);
    vi.spyOn(OwnershipJournal.prototype, 'update').mockImplementation(async (record) => record);

    const runtime = createOwnedExecutionRuntime(config(), { info() {}, warn() {}, error() {} });
    const ensureInput = {
      workspaceId: 'workspace-test',
      sessionId: 'session-test',
      sandboxScopeId: 'scope-test',
      workload: { class: 'interactive' as const },
    };
    const recipe: WorkspaceRecipe = { ...ensureInput };

    const warmup = runtime.sandboxManager.ensureRunning(ensureInput);
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    const formalProvision = runtime.provisioner.provision(recipe);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provision).not.toHaveBeenCalled();
    finishEnsure();
    await expect(warmup).resolves.toMatchObject({ workspaceId: 'workspace-test' });
    await expect(formalProvision).resolves.toMatchObject({ status: 'ok' });
    expect(ensure).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
  });
});

function config(): AcsOrchestratorConfig {
  return {
    authToken: 'test-token',
    namespace: 'test-namespace',
    pvcName: 'test-workspace-pvc',
  } as AcsOrchestratorConfig;
}

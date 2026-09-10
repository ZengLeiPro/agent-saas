import { createHash } from 'node:crypto';
import type { AcsOrchestratorConfig } from './config.js';
import { Kubectl } from './kubectl.js';
import { KubeApi } from './kubeApi.js';
import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { SandboxManager } from './sandboxManager.js';
import { AcsExecutor } from './executor.js';
import { Provisioner } from './provision.js';
import { provisionBudgets } from './provisionBudgets.js';
import { OwnershipJournal } from './ownershipJournal.js';
import { OwnedOperations } from './ownedOperations.js';
import { OwnedSharedWork } from './ownedSharedWork.js';
import { SandboxOwnershipReaders } from './sandboxOwnershipReaders.js';
import { writableScope } from './ownershipState.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';
import { deriveRemoteReceiptKey } from './remoteAttemptProtocol.js';
import { reconcileRemoteOwnership } from './remoteOwnershipReconciler.js';

export function createOwnedExecutionRuntime(config: AcsOrchestratorConfig, logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }) {
  const kubectl = new Kubectl(config);
  const kubeApi = KubeApi.tryCreate(config, logger);
  const activeRegistry = new ActiveSandboxRegistry();
  // The journal transport is deliberately outside the execution observer: its
  // own failed CAS must not recursively attempt another journal mutation.
  const ownershipJournal = new OwnershipJournal(config, new Kubectl(config));
  const ownedOperations = new OwnedOperations(ownershipJournal, {
    receiptKey: fence => deriveRemoteReceiptKey(config.authToken, fence),
  });
  kubectl.setOwnershipObserver((reason) => ownedOperations.current()?.markUncertain(reason));
  const sandboxManager = new SandboxManager(config, kubectl, logger, activeRegistry, kubeApi);
  sandboxManager.setOwnershipReaders(new SandboxOwnershipReaders(config, kubectl, ownedOperations, ownershipJournal, kubeApi));
  const executor = new AcsExecutor(config, kubectl, sandboxManager, logger, activeRegistry, { ownedOperations });
  const provisioner = new Provisioner(config, kubectl, sandboxManager, () => executor.busySandboxNames(), activeRegistry);
  const ensurePool = new OwnedSharedWork<Awaited<ReturnType<SandboxManager['ensureRunning']>>>(ownedOperations);
  const provisionPool = new OwnedSharedWork<Awaited<ReturnType<Provisioner['provision']>>>(ownedOperations);
  const ensure = sandboxManager.ensureRunning.bind(sandboxManager);
  sandboxManager.ensureRunning = (input, options = {}) => {
    const current = ownedOperations.current();
    if (current) return current.phase('ensure', () => ensure(input, options), OWNED_WAIT_BUDGETS.ensureMs, { ignoreCancellation: true });
    const ref = sandboxManager.ref(input);
    return ensurePool.run({ key: ref.name, fingerprint: digest(input), kind: 'ensure', scope: writableScope(config, ref), work: () => ensure(input, options) });
  };
  const provision = provisioner.provision.bind(provisioner);
  provisioner.provision = (recipe, options = {}) => {
    const ref = sandboxManager.ref({ workspaceId: recipe.workspaceId, sessionId: recipe.sessionId!, sandboxScopeId: recipe.sandboxScopeId, mountSubPath: recipe.mountSubPath, sharedReadOnlySubPath: recipe.sharedReadOnlySubPath });
    return provisionPool.run({ key: ref.name, fingerprint: digest(recipe), kind: 'provision', scope: writableScope(config, ref), signal: options.signal, ownerTimeoutMs: provisionBudgets(recipe).totalMs, work: () => provision(recipe) });
  };
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await reconcileRemoteOwnership({
        config,
        kubectl,
        journal: ownershipJournal,
        sandboxManager,
        operations: ownedOperations,
        logger,
      });
    }
    catch { logger.warn('ownership_journal_unavailable'); }
    finally { refreshing = false; }
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, 10_000);
  timer.unref?.();
  return { kubectl, kubeApi, activeRegistry, sandboxManager, executor, provisioner, ownershipJournal, ownedOperations };
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertPublishedDisk,
  atomicWrite,
  isOwnerAlive,
  processIdentity,
  rawRevision,
  readPublication,
  readSnapshot,
  writePublication,
} from '../../../scripts/release/config-publication.mjs';
import { acquireFileGuard } from '../config/adminConfigMutationService.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import { getAppConfigPath } from './config.js';
import type { RuntimeConfigIdentityAssembly } from './configIdentityAssembly.js';
import type { SharedConfigRefresher } from './sharedConfigRefresher.js';

/** Only stages recovery: the normal publisher still requires both process receipts. */
export async function stageInterruptedProductionConfiguration(options: {
  configPath: string;
  processCwd: string;
  releaseId: string;
  promotionLockPath?: string;
}): Promise<boolean> {
  const initial = readPublication(options.configPath);
  if (!initial || initial.phase === 'committed') return false;
  const mayRecover = (state: typeof initial): boolean => {
    if (state.releaseId !== options.releaseId)
      throw new Error('未完成配置事务属于其他发布版本，需要原版本恢复');
    return state.phase === 'recovery_required' || !state.owner || !isOwnerAlive(state.owner);
  };
  if (!mayRecover(initial)) return false;
  // Same nonblocking OS fences as AdminConfigMutationService + its publisher.
  const guard = join(options.processCwd, 'data', 'config-governance', 'config.lock.guard');
  const promotion = options.promotionLockPath ?? '/run/lock/agent-saas/promotion.lock';
  mkdirSync(dirname(guard), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(promotion), { recursive: true, mode: 0o700 });
  const releaseConfig = await acquireFileGuard(guard);
  try {
    const releasePromotion = await acquireFileGuard(promotion);
    try {
      const state = readPublication(options.configPath);
      if (!state || state.phase === 'committed' || !mayRecover(state)) return false;
      if (!state.previous) throw new Error('配置事务缺少回滚版本');
      const disk = rawRevision(readFileSync(options.configPath, 'utf8'));
      if (disk !== state.rawRevision && disk !== state.previous.rawRevision)
        throw new Error('磁盘存在事务外变更，拒绝用启动恢复覆盖');
      const previousText = readSnapshot(options.configPath, state.previous.rawRevision);
      if (
        state.phase === 'recovery_required' &&
        state.rawRevision === state.previous.rawRevision &&
        disk === state.rawRevision
      )
        return true;
      // The existing pending journal records BOTH candidate and previous bytes.
      // Restore bytes first; a crash here remains recoverable from that journal.
      // Publishing the old head first would lose the candidate digest while the
      // candidate file still exists, misclassifying our own interrupted rollback.
      atomicWrite(options.configPath, previousText);
      writePublication(options.configPath, {
        ...state,
        ...state.previous,
        phase: 'recovery_required',
        sequence: state.sequence + 1,
        owner: processIdentity(),
        updatedAt: new Date().toISOString(),
      });
      return true;
    } finally {
      await releasePromotion();
    }
  } finally {
    await releaseConfig();
  }
}

/** Runs before config parsing, credential resolution or any execution service. */
export async function prepareProductionConfigStartup(
  processCwd: string,
  processRole: string,
): Promise<void> {
  const runtime = readRuntimeIdentity();
  if (
    runtime.environment !== 'production' ||
    !runtime.releaseId ||
    !runtime.expectedConfigIdentity ||
    !['ws-only', 'runtime-worker'].includes(processRole)
  )
    return;
  await stageInterruptedProductionConfiguration({
    configPath: getAppConfigPath(processCwd),
    processCwd,
    releaseId: runtime.releaseId,
  });
}

/** Runtime construction is not business admission. Pending signed recovery must
 * be able to construct both observers; model/command/readiness gates remain shut. */
export async function alignProductionConfigStartup(options: {
  processCwd: string;
  refresher: Pick<SharedConfigRefresher, 'refreshIfChanged' | 'getAppliedStamps'>;
  identity: Pick<
    RuntimeConfigIdentityAssembly,
    'refreshSummary' | 'isExecutionAllowed' | 'recoveryGate'
  >;
}): Promise<void> {
  if (!(await options.refresher.refreshIfChanged(true))) throw new Error('共享配置启动对齐失败');
  await options.identity.refreshSummary();
  if (options.identity.isExecutionAllowed()) return;
  const runtime = readRuntimeIdentity();
  if (
    runtime.environment === 'production' &&
    runtime.releaseId &&
    runtime.expectedConfigIdentity &&
    !options.identity.recoveryGate.isDirty()
  ) {
    const state = assertPublishedDisk(getAppConfigPath(options.processCwd));
    if (
      state &&
      state.releaseId === runtime.releaseId &&
      state.phase !== 'committed' &&
      options.refresher.getAppliedStamps().config?.digest === state.rawRevision
    )
      return;
  }
  throw new Error('共享配置启动对齐失败');
}

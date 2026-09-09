import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicWrite,
  processIdentity,
  rawRevision,
  readPublication,
  saveSnapshot,
  writePublication,
} from '../../../scripts/release/config-publication.mjs';
import * as publications from '../../../scripts/release/config-publication.mjs';
import { acquireFileGuard } from '../config/adminConfigMutationService.js';
import { computeObservedConfigIdentity } from '../release/configIdentity.js';
import {
  createProductionPublicationRig,
  publicIdentity,
  type ProductionPublicationRig,
} from '../__tests__/helpers/productionPublicationRig.js';
import { parseAppConfig } from './config.js';
import { initializeRuntimeConfigIdentityAssembly } from './configIdentityAssembly.js';
import { createModelResolvers } from './modelResolvers.js';
import {
  alignProductionConfigStartup,
  stageInterruptedProductionConfiguration,
} from './productionConfigStartup.js';

let rig: ProductionPublicationRig;
beforeEach(async () => {
  rig = await createProductionPublicationRig();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rig.close();
});

function stage() {
  return stageInterruptedProductionConfiguration({
    configPath: rig.configPath,
    processCwd: rig.processCwd,
    releaseId: 'test-release',
    promotionLockPath: join(rig.root, 'promotion.lock'),
  });
}
async function pending(afterReplacement: boolean, alive = false) {
  const raw = structuredClone(rig.raw);
  raw.models.groups[0].models[0].name = 'Interrupted candidate';
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const identity = publicIdentity(
    await computeObservedConfigIdentity(parseAppConfig(raw), rig.vault, rig.processCwd),
  );
  saveSnapshot(rig.configPath, text);
  const state = writePublication(rig.configPath, {
    ...rig.baseline,
    revision: randomUUID(),
    sequence: 2,
    phase: 'applying',
    rawRevision: rawRevision(text),
    identity,
    previous: {
      revision: rig.baseline.revision,
      rawRevision: rig.baseline.rawRevision,
      identity: rig.expected,
    },
    owner: alive ? processIdentity() : { ...processIdentity(), bootId: 'previous-system-boot' },
  });
  if (afterReplacement) atomicWrite(rig.configPath, text);
  return state;
}
function productionEnvironment() {
  vi.stubEnv('AGENT_SAAS_ENVIRONMENT', 'production');
  vi.stubEnv('AGENT_SAAS_RELEASE_ID', 'test-release');
  vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION', '1');
  vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_DIGEST', rig.expected.digest);
  vi.stubEnv(
    'AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST',
    rig.expected.credentialVersionDigest ?? '',
  );
  vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_PATH', join(rig.root, 'startup-summary.json'));
}
async function alignedRuntime() {
  productionEnvironment();
  const config = parseAppConfig(JSON.parse(readFileSync(rig.configPath, 'utf8')));
  const identity = await initializeRuntimeConfigIdentityAssembly({
    config,
    secretVault: rig.vault,
    processCwd: rig.processCwd,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  const { sharedConfigRefresher } = createModelResolvers({
    config,
    processCwd: rig.processCwd,
    recoveryGate: identity.recoveryGate,
    titleGeneratorConfigs: [],
    onGuardrailModelConfigsUpdated: () => {},
    getGuardrailModelConfigs: () => [],
    prepareSystemPromptOverridesUpdate: () => () => {},
    ...identity.modelResolverHooks,
  });
  return { identity, refresher: sharedConfigRefresher, processCwd: rig.processCwd };
}

describe('production cold-start recovery', () => {
  it.each([false, true])(
    'restores the old signed snapshot after replacement=%s without granting readiness',
    async (afterReplacement) => {
      await pending(afterReplacement);
      expect(await stage()).toBe(true);
      expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
      expect(readPublication(rig.configPath)?.phase).toBe('recovery_required');
      expect(rig.nodes[0].view.isExecutionAllowed()).toBe(false);
      const boot = await alignedRuntime();
      await expect(alignProductionConfigStartup(boot)).resolves.toBeUndefined();
      expect(boot.identity.isExecutionAllowed()).toBe(false);
      expect(boot.identity.getSummary().status).toBe('not_collected');
      await rig.service.recoverProductionPublication();
      await boot.identity.refreshSummary();
      expect(readPublication(rig.configPath)?.phase).toBe('committed');
      expect(boot.identity.isExecutionAllowed()).toBe(true);
      expect(rig.appliedPhases.some((value) => value.startsWith('ws-only:committed:'))).toBe(true);
      expect(rig.appliedPhases.some((value) => value.startsWith('runtime-worker:committed:'))).toBe(
        true,
      );
    },
  );
  it('allows an observer to start during an alive publisher but never admits new work', async () => {
    const intent = await pending(true, true);
    expect(await stage()).toBe(false);
    expect(readPublication(rig.configPath)).toEqual(intent);
    const boot = await alignedRuntime();
    await expect(alignProductionConfigStartup(boot)).resolves.toBeUndefined();
    expect(boot.identity.isExecutionAllowed()).toBe(false);
  });
  it('can retry a crash after old bytes were restored but before the pending head was rewritten', async () => {
    const intent = await pending(true);
    const fault = vi.spyOn(publications, 'writePublication').mockImplementationOnce(() => {
      throw new Error('injected head interruption');
    });
    await expect(stage()).rejects.toThrow('injected head interruption');
    fault.mockRestore();
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
    expect(readPublication(rig.configPath)).toEqual(intent);
    expect(await stage()).toBe(true);
    expect(readPublication(rig.configPath)?.phase).toBe('recovery_required');
  });
  it('rollback keeps candidate and previous digests journaled until old bytes are durable', async () => {
    rig.blockedPhases.add('runtime-worker:applying');
    const original = publications.writePublication;
    let checked = false;
    vi.spyOn(publications, 'writePublication').mockImplementation((path, record) => {
      if (record.phase === 'rolling_back') {
        expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
        checked = true;
      }
      return original(path, record);
    });
    await expect(rig.service.mutate(rig.input())).rejects.toThrow('超时');
    expect(checked).toBe(true);
    expect(readPublication(rig.configPath)?.phase).toBe('committed');
  });
  it('staged recovery is idempotent and still requires two observers', async () => {
    await pending(true);
    await stage();
    const staged = readPublication(rig.configPath);
    await stage();
    expect(readPublication(rig.configPath)).toEqual(staged);
    expect(rig.publisher.getWritePolicy().canSave).toBe(false);
  });
  it('does not overwrite an out-of-transaction disk change', async () => {
    const intent = await pending(true);
    const foreign = '{"foreign":true}\n';
    writeFileSync(rig.configPath, foreign);
    await expect(stage()).rejects.toThrow('事务外变更');
    expect(readFileSync(rig.configPath, 'utf8')).toBe(foreign);
    expect(readPublication(rig.configPath)).toEqual(intent);
  });
  it('does not restore a snapshot whose bytes were changed', async () => {
    await pending(true);
    const disk = readFileSync(rig.configPath, 'utf8');
    writeFileSync(
      join(rig.root, 'config-publications', 'snapshots', `${rig.baseline.rawRevision}.jsonc`),
      'tampered',
    );
    await expect(stage()).rejects.toThrow('integrity');
    expect(readFileSync(rig.configPath, 'utf8')).toBe(disk);
  });
  it('refuses a different code release and preserves the pending journal', async () => {
    const intent = await pending(true);
    await expect(
      stageInterruptedProductionConfiguration({
        configPath: rig.configPath,
        processCwd: rig.processCwd,
        releaseId: 'other-release',
        promotionLockPath: join(rig.root, 'promotion.lock'),
      }),
    ).rejects.toThrow('其他发布版本');
    expect(readPublication(rig.configPath)).toEqual(intent);
  });
  it('does not modify a committed version', async () => {
    expect(await stage()).toBe(false);
    expect(readPublication(rig.configPath)).toEqual(rig.baseline);
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
  });
  it('cannot stage recovery while a deployment owns the promotion fence', async () => {
    const intent = await pending(true);
    const release = await acquireFileGuard(join(rig.root, 'promotion.lock'));
    try {
      await expect(stage()).rejects.toThrow();
      expect(readPublication(rig.configPath)).toEqual(intent);
    } finally {
      await release();
    }
    expect(await stage()).toBe(true);
  });
  it('does not mask failed application, stale applied bytes, dirty runtime or committed denial', async () => {
    await pending(true);
    await stage();
    const boot = await alignedRuntime();
    const refresh = vi.spyOn(boot.refresher, 'refreshIfChanged').mockResolvedValueOnce(false);
    await expect(alignProductionConfigStartup(boot)).rejects.toThrow('启动对齐失败');
    refresh.mockRestore();
    await alignProductionConfigStartup(boot);
    const emptyConfigStamp = { ...boot.refresher.getAppliedStamps(), config: undefined };
    const stamp = vi.spyOn(boot.refresher, 'getAppliedStamps').mockReturnValue(emptyConfigStamp);
    await expect(alignProductionConfigStartup(boot)).rejects.toThrow('启动对齐失败');
    stamp.mockRestore();
    const dirty = vi.spyOn(boot.identity.recoveryGate, 'isDirty').mockReturnValue(true);
    await expect(alignProductionConfigStartup(boot)).rejects.toThrow('启动对齐失败');
    dirty.mockRestore();
    await rig.service.recoverProductionPublication();
    vi.spyOn(boot.identity, 'isExecutionAllowed').mockReturnValue(false);
    await expect(alignProductionConfigStartup(boot)).rejects.toThrow('启动对齐失败');
  });
  it('production assembly stages disk recovery before parsing and does not conflate startup with admission', () => {
    const source = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
    const prepare = source.indexOf('await prepareProductionConfigStartup(processCwd, processRole)');
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(source.indexOf('const config = loadAppConfig(processCwd)'));
    expect(source).toContain(
      'await alignProductionConfigStartup({ processCwd, refresher: sharedConfigRefresher, identity: configIdentityAssembly })',
    );
    expect(source).not.toContain('if (!await refreshPublishedConfig(true))');
    expect(source).toContain('sessionAutomationFlagSource.attachRefresh(refreshPublishedConfig)');
  });
});

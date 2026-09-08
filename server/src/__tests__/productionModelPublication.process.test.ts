import { buildSync } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicWrite, processIdentity, rawRevision, readPublication, preparePublicationAuthority,
  type PublishedIdentity,
} from '../../../scripts/release/config-publication.mjs';
import { parseAppConfig } from '../app/config.js';
import { createModelResolvers } from '../app/modelResolvers.js';
import { createProductionConfigIdentityView } from '../app/productionConfigIdentity.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { computeObservedConfigIdentity } from '../release/configIdentity.js';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { ProductionModelPublisher, type PublicationTarget } from '../config/productionModelPublisher.js';

type WorkerReply = { ready?: boolean; id?: number; ok?: boolean; error?: string; model?: string; allowed?: boolean };
let bundleRoot: string;
let workerEntry: string;
beforeAll(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'production-worker-bundle-'));
  workerEntry = join(bundleRoot, 'worker.mjs');
  symlinkSync(resolve('node_modules'), join(bundleRoot, 'node_modules'), 'dir');
  buildSync({ entryPoints: [resolve('src/__tests__/helpers/productionPublicationWorker.ts')],
    outfile: workerEntry, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    packages: 'external', alias: {
      '@agent/shared/schemas/configIdentity': resolve('../shared/src/schemas/configIdentity.ts'),
      '@agent/shared': resolve('../shared/src/index.ts'),
    }, banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
});
afterAll(() => { rmSync(bundleRoot, { recursive: true, force: true }); });

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  await exited;
}

describe('production save across OS processes', () => {
  let root: string;
  let processCwd: string;
  let configPath: string;
  let child: ChildProcess | undefined;
  let expected: PublishedIdentity;
  let nextRequest = 1;
  let before: string;
  let restartDuringApply = false;
  let restartCount = 0;
  let observe: () => Promise<void>;
  let service: AdminConfigMutationService;
  let queryWorker: () => Promise<WorkerReply>;

  const startWorker = async () => {
    const worker = fork(workerEntry, [configPath, processCwd, join(root, 'worker.applied'), JSON.stringify(expected)],
      { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostics = '';
    worker.stderr?.on('data', (chunk: Buffer) => { diagnostics += String(chunk); });
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Worker did not start: ${diagnostics}`)), 5_000);
      const onMessage = (message: WorkerReply) => {
        if (message.ready) { clearTimeout(timeout); worker.off('message', onMessage); done(); }
      };
      worker.on('message', onMessage);
      worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
      worker.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Worker exited ${code}: ${diagnostics}`)); });
    });
    child = worker;
  };

  beforeEach(async () => {
    restartDuringApply = false;
    restartCount = 0;
    root = mkdtempSync(join(tmpdir(), 'production-cross-process-'));
    processCwd = join(root, 'server');
    mkdirSync(processCwd);
    configPath = join(root, 'config.json');
    vi.stubEnv('AGENT_SAAS_CONFIG_PATH', configPath);
    const raw = { agent: { cwd: './workspace' }, server: { port: 3200 },
      models: { default: 'main/model', groups: [{ id: 'main', name: 'Main',
        baseUrl: 'https://synthetic.example.invalid/v1', protocol: 'chat_completions',
        models: [{ id: 'model', name: 'Model', value: 'before-save' }] }] } };
    before = `${JSON.stringify(raw)}\n`;
    writeFileSync(configPath, before);
    const config = parseAppConfig(raw);
    const vault = new InMemorySecretVault();
    const original = await computeObservedConfigIdentity(config, vault, processCwd);
    expected = { schemaVersion: 1, digest: original.digest,
      ...(original.credentialVersionDigest ? { credentialVersionDigest: original.credentialVersionDigest } : {}) };
    preparePublicationAuthority(configPath, 'cross-process-release', expected);
    await startWorker();
    queryWorker = () => new Promise<WorkerReply>((done, reject) => {
      const target = child!;
      const id = nextRequest++;
      const timer = setTimeout(() => { target.off('message', onMessage); reject(new Error('Worker acknowledgement timeout')); }, 3_000);
      function onMessage(message: WorkerReply) {
        if (message.id !== id) return;
        clearTimeout(timer);
        target.off('message', onMessage);
        if (message.ok) done(message); else reject(new Error(message.error));
      }
      target.on('message', onMessage);
      target.send({ command: 'observe', id });
    });
    const view = createProductionConfigIdentityView({ environment: 'production', configPath,
      releaseId: 'cross-process-release', expected, processCwd, secretVault: vault });
    const resolvers = createModelResolvers({ config, processCwd, titleGeneratorConfigs: [],
      onGuardrailModelConfigsUpdated: () => {}, getGuardrailModelConfigs: () => [],
      prepareSystemPromptOverridesUpdate: () => () => {}, validateConfigReload: view.validatePublishedReload,
      isConfigAdmissionAllowed: view.isExecutionAllowed });
    const targets = (): PublicationTarget[] => [
      { role: 'ws-only', process: processIdentity(), receiptPath: join(root, 'api.applied') },
      { role: 'runtime-worker', process: processIdentity(child!.pid!), receiptPath: join(root, 'worker.applied') },
    ];
    observe = async () => {
      const state = readPublication(configPath)!;
      if (!await resolvers.sharedConfigRefresher.refreshIfChanged(true)) throw new Error('API refused candidate');
      const observed = await computeObservedConfigIdentity(config, vault, processCwd);
      atomicWrite(join(root, 'api.applied'), `${JSON.stringify({ schemaVersion: 1, releaseId: 'cross-process-release',
        role: 'ws-only', process: processIdentity(), revision: state.revision, sequence: state.sequence,
        phase: state.phase, rawRevision: resolvers.sharedConfigRefresher.getAppliedStamps().config?.digest,
        identity: { schemaVersion: 1, digest: observed.digest,
          ...(observed.credentialVersionDigest ? { credentialVersionDigest: observed.credentialVersionDigest } : {}) },
        recordedAt: Date.now() })}\n`);
      if (restartDuringApply && state.phase === 'applying') {
        restartDuringApply = false;
        await stopChild(child);
        await startWorker();
        restartCount += 1;
      }
      await queryWorker();
    };
    const publisher = new ProductionModelPublisher({ configPath, processCwd,
      releaseId: 'cross-process-release', expected, secretVault: vault, targets,
      observeLocal: observe, timeoutMs: 3_000, pollMs: 10 });
    service = new AdminConfigMutationService({ configPath, processCwd, environment: 'production',
      processRole: 'ws-only', productionPublisher: publisher });
  });
  afterEach(async () => {
    await stopChild(child);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const save = (model: string) => {
    const revision = rawRevision(readFileSync(configPath, 'utf8'));
    return service.mutate({ actor: 'admin', changedPaths: ['models'], expectedRevision: revision,
      productionConfirmation: revision, buildCandidate: (text) => {
        const next = JSON.parse(text);
        next.models.groups[0].models[0].value = model;
        return `${JSON.stringify(next)}\n`;
      }, applyRuntime: () => { throw new Error('Partial update is forbidden'); } });
  };

  it('confirms an independent Worker and retains the online version across a Worker restart', async () => {
    await save('after-save');
    expect((await queryWorker()).model).toBe('after-save');
    const oldPid = child!.pid;
    await stopChild(child);
    await startWorker();
    expect(child!.pid).not.toBe(oldPid);
    await observe();
    expect(await queryWorker()).toMatchObject({ model: 'after-save', allowed: true });
    await save('second-save');
    expect(await queryWorker()).toMatchObject({ model: 'second-save', allowed: true });
  });

  it('does not trust the former Worker PID after a restart during save and fully restores the baseline', async () => {
    restartDuringApply = true;
    await expect(save('must-rollback')).rejects.toThrow('变化');
    expect(restartCount).toBe(1);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(await queryWorker()).toMatchObject({ model: 'before-save', allowed: true });
    expect(readPublication(configPath)?.phase).toBe('committed');
  });
});

import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { vi } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  atomicWrite, canonical, preparePublicationAuthority, processIdentity, rawRevision,
  readPublication, type ConfigPublication, type PublishedIdentity,
} from '../../../../scripts/release/config-publication.mjs';
import { createModelResolvers } from '../../app/modelResolvers.js';
import { parseAppConfig, type AppConfig } from '../../app/config.js';
import { createProductionConfigIdentityView } from '../../app/productionConfigIdentity.js';
import { computeObservedConfigIdentity } from '../../release/configIdentity.js';
import { resolveModelsConfig } from '../../app/runtimeGovernanceCredentials.js';
import { AdminConfigMutationService, type MutationInput } from '../../config/adminConfigMutationService.js';
import { ProductionModelPublisher, type PublicationReceipt, type PublicationTarget } from '../../config/productionModelPublisher.js';
import { createModelsAdminRouter } from '../../routes/modelsAdmin.js';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';
import { GLOBAL_OWNER_ID, InMemorySecretVault } from '../../security/secretVault.js';

export function publicIdentity(value: { digest: string; credentialVersionDigest?: string | null }): PublishedIdentity {
  return { schemaVersion: 1, digest: value.digest,
    ...(value.credentialVersionDigest ? { credentialVersionDigest: value.credentialVersionDigest } : {}) };
}
export async function createProductionPublicationRig() {
  const root = mkdtempSync(join(tmpdir(), 'production-model-save-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd);
  const configPath = join(root, 'config.json');
  vi.stubEnv('AGENT_SAAS_CONFIG_PATH', configPath);
  const vault = new InMemorySecretVault();
  const oldRef = await vault.putSecret(GLOBAL_OWNER_ID, 'models', 'old-secret', {
    actor: 'system', userId: 'models_config_admin', scopes: ['secret:models:write'],
  });
  const raw = {
    agent: { cwd: './workspace' }, server: { port: 3200 },
    models: { default: 'main/model', allowCrossGroupSwitch: true, groups: [{
      id: 'main', name: 'Main', protocol: 'chat_completions',
      apiKeyRef: oldRef.id, baseUrl: 'https://model.example.invalid/v1',
      models: [{ id: 'model', name: 'Original', value: 'original-model' }],
    }] },
    titleGenerator: { model: 'main/model', fallbackModels: [] },
  };
  const before = `${JSON.stringify(raw, null, 2)}\n`;
  writeFileSync(configPath, before);
  const expected = publicIdentity(await computeObservedConfigIdentity(parseAppConfig(raw), vault, processCwd));
  const baseline = preparePublicationAuthority(configPath, 'test-release', expected);
  const targets: PublicationTarget[] = (['ws-only', 'runtime-worker'] as const).map((role) => ({
    role, process: processIdentity(), receiptPath: join(root, `${role}.applied`),
  }));
  const appliedPhases: string[] = [];
  const blockedPhases = new Set<string>();
  let corruptReceipt: ((value: PublicationReceipt) => PublicationReceipt) | undefined;
  let beforeObserve: ((state: ConfigPublication) => Promise<void> | void) | undefined;
  let topology = targets;
  const nodes = await Promise.all(targets.map(async (target) => {
    const config = parseAppConfig(raw);
    const view = createProductionConfigIdentityView({ environment: 'production', configPath,
      releaseId: 'test-release', expected, processCwd, secretVault: vault });
    let embeddingModel = config.memory?.index?.embedding.model;
    const resolvers = createModelResolvers({ config, processCwd, titleGeneratorConfigs: [],
      onGuardrailModelConfigsUpdated: () => {}, getGuardrailModelConfigs: () => [],
      prepareSystemPromptOverridesUpdate: () => () => {},
      initialRuntimeModels: await resolveModelsConfig(config.models!, vault),
      resolveRuntimeModels: (models) => resolveModelsConfig(models, vault),
      validateConfigReload: view.validatePublishedReload,
      isConfigAdmissionAllowed: view.isExecutionAllowed,
      prepareMemoryIndexUpdate: async (index) => {
        const previous = embeddingModel;
        return { commit: () => { embeddingModel = index?.embedding.model; },
          rollback: () => { embeddingModel = previous; }, complete: () => {}, dispose: () => {} };
      },
    });
    return { target, config, view, resolvers, getEmbeddingModel: () => embeddingModel };
  }));
  const observe = async () => {
    const state = readPublication(configPath)!;
    await beforeObserve?.(state);
    for (const node of nodes) {
      if (blockedPhases.has(`${node.target.role}:${state.phase}`)) continue;
      if (!await node.resolvers.sharedConfigRefresher.refreshIfChanged(true)) continue;
      const applied = node.resolvers.sharedConfigRefresher.getAppliedStamps().config;
      if (applied?.digest !== state.rawRevision) continue;
      const observed = publicIdentity(await computeObservedConfigIdentity(node.config, vault, processCwd));
      if (canonical(observed) !== canonical(state.identity)) continue;
      const receipt: PublicationReceipt = {
        schemaVersion: 1, releaseId: 'test-release', role: node.target.role,
        process: node.target.process, revision: state.revision, sequence: state.sequence,
        phase: state.phase, rawRevision: applied.digest, identity: observed, recordedAt: Date.now(),
      };
      atomicWrite(node.target.receiptPath, `${JSON.stringify(corruptReceipt?.(receipt) ?? receipt)}\n`);
      appliedPhases.push(`${node.target.role}:${state.phase}:${state.revision}`);
    }
  };
  const publisher = new ProductionModelPublisher({ configPath, processCwd, releaseId: 'test-release',
    expected, secretVault: vault, targets: () => topology, observeLocal: observe, timeoutMs: 150, pollMs: 5 });
  const service = new AdminConfigMutationService({ configPath, processCwd, environment: 'production',
    processRole: 'ws-only', productionPublisher: publisher });
  const input = (patch: (value: typeof raw) => void = (value) => { value.models.groups[0].models[0].name = 'Updated'; }): MutationInput => {
    const revision = rawRevision(readFileSync(configPath, 'utf8'));
    return { actor: 'admin', changedPaths: ['models'], expectedRevision: revision,
      productionConfirmation: revision, buildCandidate: (text) => {
        const value = parseJsonc(text) as typeof raw;
        patch(value);
        return `${JSON.stringify(value, null, 2)}\n`;
      }, applyRuntime: () => { throw new Error('The partial HTTP runtime recipe must never execute in production'); } };
  };
  let server: Server | undefined;
  const startHttp = async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID } as typeof req.user;
      next();
    });
    app.use('/api/admin/models', createModelsAdminRouter({ processCwd, config: nodes[0].config,
      secretVault: vault, configMutationService: service, requireRevision: true }));
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP bind failed');
    return `http://127.0.0.1:${address.port}/api/admin/models`;
  };
  return { root, processCwd, configPath, raw, before, vault, oldRef, baseline, expected, targets,
    nodes, publisher, service, input, observe, appliedPhases, blockedPhases, startHttp,
    setCorruptReceipt: (value: typeof corruptReceipt) => { corruptReceipt = value; },
    setBeforeObserve: (value: typeof beforeObserve) => { beforeObserve = value; },
    setTopology: (value: PublicationTarget[]) => { topology = value; },
    close: async () => {
      if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export type ProductionPublicationRig = Awaited<ReturnType<typeof createProductionPublicationRig>>;

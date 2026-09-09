// Test-only worker entrypoint, bundled by the cross-process integration test.
import { readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  assertPublishedDisk,
  atomicWrite,
  canonical,
  processIdentity,
  type PublishedIdentity,
} from '../../../../scripts/release/config-publication.mjs';
import { parseAppConfig } from '../../app/config.js';
import { createModelResolvers } from '../../app/modelResolvers.js';
import { createProductionConfigIdentityView } from '../../app/productionConfigIdentity.js';
import { computeObservedConfigIdentity } from '../../release/configIdentity.js';
import { InMemorySecretVault } from '../../security/secretVault.js';

const [configPath, processCwd, receiptPath, expectedJson] = process.argv.slice(2);
if (!configPath || !processCwd || !receiptPath || !expectedJson || !process.send)
  throw new Error('Invalid test worker arguments');
process.env.AGENT_SAAS_CONFIG_PATH = configPath;
const expected = JSON.parse(expectedJson) as PublishedIdentity;
const vault = new InMemorySecretVault();
const config = parseAppConfig(parseJsonc(readFileSync(configPath, 'utf8')));
const view = createProductionConfigIdentityView({
  environment: 'production',
  configPath,
  releaseId: 'cross-process-release',
  expected,
  processCwd,
  secretVault: vault,
});
const resolvers = createModelResolvers({
  config,
  processCwd,
  titleGeneratorConfigs: [],
  onGuardrailModelConfigsUpdated: () => {},
  getGuardrailModelConfigs: () => [],
  prepareSystemPromptOverridesUpdate: () => () => {},
  validateConfigReload: view.validatePublishedReload,
  isConfigAdmissionAllowed: view.isExecutionAllowed,
});
let work = Promise.resolve();
process.on('message', (value: { id: number; command: string }) => {
  work = work
    .then(async () => {
      if (value.command !== 'observe') throw new Error('Invalid test worker command');
      const state = assertPublishedDisk(configPath)!;
      if (!(await resolvers.sharedConfigRefresher.refreshIfChanged(true)))
        throw new Error('Worker refused candidate');
      const observed = await computeObservedConfigIdentity(config, vault, processCwd);
      const identity = {
        schemaVersion: 1,
        digest: observed.digest,
        ...(observed.credentialVersionDigest
          ? { credentialVersionDigest: observed.credentialVersionDigest }
          : {}),
      };
      if (canonical(identity) !== canonical(state.identity))
        throw new Error('Worker identity mismatch');
      const rawRevision = resolvers.sharedConfigRefresher.getAppliedStamps().config?.digest;
      if (
        rawRevision !== state.rawRevision ||
        canonical(assertPublishedDisk(configPath)) !== canonical(state)
      ) {
        throw new Error('Worker application became stale');
      }
      atomicWrite(
        receiptPath,
        `${JSON.stringify({
          schemaVersion: 1,
          releaseId: 'cross-process-release',
          role: 'runtime-worker',
          process: processIdentity(),
          revision: state.revision,
          sequence: state.sequence,
          phase: state.phase,
          rawRevision,
          identity,
          recordedAt: Date.now(),
        })}\n`,
      );
      process.send!({
        id: value.id,
        ok: true,
        model: config.models!.groups[0].models[0].value,
        allowed: view.isExecutionAllowed(),
        rawRevision,
      });
    })
    .catch((error: unknown) => {
      process.send!({
        id: value.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});
process.send({ ready: true, pid: process.pid });

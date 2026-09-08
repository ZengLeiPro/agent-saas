import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  atomicWrite, processIdentity, rawRevision, readPublication, saveSnapshot, writePublication,
} from '../../../scripts/release/config-publication.mjs';
import {
  ConfigConflictError, ConfigMutationCommittedError, RuntimeRestoreFailedError,
} from '../config/adminConfigMutationService.js';
import { parseAppConfig } from '../app/config.js';
import { computeObservedConfigIdentity } from '../release/configIdentity.js';
import { createProductionPublicationRig, publicIdentity, type ProductionPublicationRig } from './helpers/productionPublicationRig.js';

describe('production model configuration publication', () => {
  let rig: ProductionPublicationRig;
  beforeEach(async () => { rig = await createProductionPublicationRig(); });
  afterEach(async () => { await rig?.close(); });

  it('actually saves production models and confirms both independently applied runtime views', async () => {
    expect(rig.service.getWritePolicy().canSave).toBe(true);
    const result = await rig.service.mutate(rig.input());
    const state = readPublication(rig.configPath)!;
    expect(state.phase).toBe('committed');
    expect(state.revision).not.toBe(rig.baseline.revision);
    expect(result.revision).toBe(rawRevision(readFileSync(rig.configPath, 'utf8')));
    for (const node of rig.nodes) {
      expect(node.config.models!.groups[0].models[0].name).toBe('Updated');
      expect(node.resolvers.modelResolver?.('main/model')?.model).toBe('original-model');
      expect(rig.appliedPhases).toContain(`${node.target.role}:committed:${state.revision}`);
      expect(node.view.isExecutionAllowed()).toBe(true);
    }
  });

  it('blocks new model resolution during an applying transaction', async () => {
    let checked = false;
    rig.setBeforeObserve((state) => {
      if (state.phase === 'applying') {
        for (const node of rig.nodes) {
          expect(node.view.isExecutionAllowed()).toBe(false);
          expect(node.resolvers.modelResolver?.('main/model')).toBeNull();
        }
        checked = true;
      }
    });
    await rig.service.mutate(rig.input());
    expect(checked).toBe(true);
  });

  it('rejects a stale revision before creating candidate credentials', async () => {
    const input = rig.input();
    input.expectedRevision = 'stale-page';
    const build = vi.fn(input.buildCandidate);
    input.buildCandidate = build;
    await expect(rig.service.mutate(input)).rejects.toBeInstanceOf(ConfigConflictError);
    expect(build).not.toHaveBeenCalled();
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
  });

  it('requires confirmation of this exact production revision', async () => {
    const input = rig.input();
    delete input.productionConfirmation;
    const build = vi.fn(input.buildCandidate);
    input.buildCandidate = build;
    await expect(rig.service.mutate(input)).rejects.toThrow('确认');
    expect(build).not.toHaveBeenCalled();
  });

  it('checks the actual candidate scope rather than trusting changedPaths', async () => {
    await expect(rig.service.mutate(rig.input((raw) => { raw.agent.cwd = '/different'; }))).rejects.toThrow('其他配置段');
    expect(readPublication(rig.configPath)).toEqual(rig.baseline);
  });

  it('rejects unresolved auxiliary model references without publishing', async () => {
    await expect(rig.service.mutate(rig.input((raw) => { raw.titleGenerator.model = 'missing/model'; }))).rejects.toThrow();
    expect(readPublication(rig.configPath)).toEqual(rig.baseline);
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
  });

  it('rolls back disk and both runtimes when Worker never applies the candidate', async () => {
    rig.blockedPhases.add('runtime-worker:applying');
    await expect(rig.service.mutate(rig.input())).rejects.toThrow('超时');
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
    expect(readPublication(rig.configPath)?.phase).toBe('committed');
    for (const node of rig.nodes) {
      expect(node.config.models!.groups[0].models[0].name).toBe('Original');
      expect(node.view.isExecutionAllowed()).toBe(true);
    }
  });

  it.each(['old-time', 'future-time', 'wrong-pid', 'wrong-release', 'wrong-sequence', 'wrong-digest'])(
    'does not accept a %s receipt as proof of application', async (fault) => {
      rig.setCorruptReceipt((receipt) => {
        if (receipt.phase !== 'applying' || receipt.role !== 'runtime-worker') return receipt;
        if (fault === 'old-time') return { ...receipt, recordedAt: Date.now() - 60_000 };
        if (fault === 'future-time') return { ...receipt, recordedAt: Date.now() + 60_000 };
        if (fault === 'wrong-pid') return { ...receipt, process: { ...receipt.process, pid: receipt.process.pid + 1 } };
        if (fault === 'wrong-release') return { ...receipt, releaseId: 'another-release' };
        if (fault === 'wrong-sequence') return { ...receipt, sequence: receipt.sequence - 1 };
        return { ...receipt, identity: { schemaVersion: 1, digest: `sha256:${'0'.repeat(64)}` } };
      });
      await expect(rig.service.mutate(rig.input())).rejects.toThrow('超时');
      expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
    },
  );

  it('keeps a durable committed version when only its final acknowledgement is lost', async () => {
    rig.setCorruptReceipt((receipt) => receipt.phase === 'committed' && receipt.revision !== rig.baseline.revision
      ? { ...receipt, recordedAt: 0 } : receipt);
    await expect(rig.service.mutate(rig.input())).rejects.toBeInstanceOf(ConfigMutationCommittedError);
    expect(readPublication(rig.configPath)?.phase).toBe('committed');
    expect(JSON.parse(readFileSync(rig.configPath, 'utf8')).models.groups[0].models[0].name).toBe('Updated');
  });

  it('retains recovery_required rather than claiming rollback when Worker is unavailable', async () => {
    rig.blockedPhases.add('runtime-worker:applying');
    rig.blockedPhases.add('runtime-worker:rolling_back');
    await expect(rig.service.mutate(rig.input())).rejects.toBeInstanceOf(RuntimeRestoreFailedError);
    expect(readPublication(rig.configPath)?.phase).toBe('recovery_required');
    expect(rig.nodes[0].view.isExecutionAllowed()).toBe(false);
    rig.blockedPhases.clear();
    await rig.service.recoverProductionPublication();
    expect(readPublication(rig.configPath)?.phase).toBe('committed');
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
  });

  it.each([false, true])('recovers a dead publisher with candidate file written=%s', async (writeCandidate) => {
    const candidate = JSON.stringify({ ...rig.raw, models: { ...rig.raw.models, allowCrossGroupSwitch: false } });
    const candidateIdentity = publicIdentity(await computeObservedConfigIdentity(parseAppConfig(JSON.parse(candidate)), rig.vault, rig.processCwd));
    saveSnapshot(rig.configPath, candidate);
    writePublication(rig.configPath, { ...rig.baseline, phase: 'applying', sequence: rig.baseline.sequence + 1,
      revision: randomUUID(), rawRevision: rawRevision(candidate), identity: candidateIdentity,
      previous: { revision: rig.baseline.revision, rawRevision: rig.baseline.rawRevision, identity: rig.expected },
      owner: { ...processIdentity(), bootId: randomUUID() }, actor: 'admin', changedPaths: ['models'] });
    if (writeCandidate) atomicWrite(rig.configPath, candidate);
    await rig.service.recoverProductionPublication();
    expect(readPublication(rig.configPath)?.phase).toBe('committed');
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
  });

  it('does not overwrite an out-of-transaction disk edit while recovering', async () => {
    const candidate = JSON.stringify({ ...rig.raw, server: { port: 3300 } });
    writePublication(rig.configPath, { ...rig.baseline, phase: 'recovery_required', sequence: 2,
      previous: { revision: rig.baseline.revision, rawRevision: rig.baseline.rawRevision, identity: rig.expected },
      owner: { ...processIdentity(), bootId: randomUUID() } });
    writeFileSync(rig.configPath, candidate);
    await expect(rig.service.recoverProductionPublication()).rejects.toBeInstanceOf(RuntimeRestoreFailedError);
    expect(readFileSync(rig.configPath, 'utf8')).toBe(candidate);
  });

  it('cannot make two concurrent admin saves overwrite one another', async () => {
    const first = rig.input();
    const second = rig.input((raw) => { raw.models.groups[0].models[0].name = 'Other'; });
    const outcomes = await Promise.allSettled([rig.service.mutate(first), rig.service.mutate(second)]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
    expect(readPublication(rig.configPath)?.phase).toBe('committed');
  });

  it('returns HTTP 200 only after production key and model changes apply to both runtimes', async () => {
    const url = await rig.startHttp();
    const initial = await (await fetch(url)).json();
    const body = { ...initial, models: { ...initial.models, groups: initial.models.groups.map((group: Record<string, unknown>) => ({ ...group, apiKey: 'replacement-secret', name: 'Renamed' })) },
      expectedRevision: initial.revision, productionConfirmation: initial.revision };
    // GET titleSystemPrompt is a view; PUT accepts only its content string.
    body.titleSystemPrompt = initial.titleSystemPrompt.content;
    const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.writePolicy.canSave).toBe(true);
    expect(JSON.stringify(result)).not.toContain('replacement-secret');
    expect(JSON.stringify(result)).not.toContain('old-secret');
    const written = JSON.parse(readFileSync(rig.configPath, 'utf8'));
    expect(written.models.groups[0].apiKey).toBeUndefined();
    expect(written.models.groups[0].apiKeyRef).not.toBe(rig.oldRef.id);
    for (const node of rig.nodes) {
      expect(node.resolvers.modelResolver?.('main/model')?.apiKey).toBe('replacement-secret');
      expect(node.config.models!.groups[0].name).toBe('Renamed');
    }
    // Old refs remain available for inflight snapshots and signed rollback history.
    expect(await rig.vault.getSecret(rig.oldRef.id, { actor: 'system', userId: '__system__', scopes: ['secret:models:read'] })).toBe('old-secret');
  });

  it('applies memory.index in the same two-runtime transaction as model settings', async () => {
    const url = await rig.startHttp();
    const initial = await (await fetch(url)).json();
    const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: initial.models, expectedRevision: initial.revision, productionConfirmation: initial.revision,
        memoryIndex: { enabled: false, embedding: { baseUrl: 'https://embedding.example.invalid/v1', apiKey: 'embedding-secret', model: 'new-embedding', dimensions: 256 } } }) });
    expect(response.status).toBe(200);
    for (const node of rig.nodes) {
      expect(node.getEmbeddingModel()).toBe('new-embedding');
      expect(node.config.memory?.index?.embedding.model).toBe('new-embedding');
    }
  });
});

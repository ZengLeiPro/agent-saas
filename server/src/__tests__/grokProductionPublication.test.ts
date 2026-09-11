import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawRevision, readPublication } from '../../../scripts/release/config-publication.mjs';
import { createProductionPublicationRig } from './helpers/productionPublicationRig.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { grokTokens } from './grokTestFixtures.js';
import type { MutationInput } from '../config/adminConfigMutationService.js';
let rig: Awaited<ReturnType<typeof createProductionPublicationRig>>;
beforeEach(async () => {
  rig = await createProductionPublicationRig();
});
afterEach(() => {
  rig.close();
  vi.restoreAllMocks();
});
function registration(ref: string): MutationInput {
  const current = rawRevision(readFileSync(rig.configPath, 'utf8'));
  return {
    ...rig.input(),
    operation: { id: 'grok.complete' },
    operationId: randomUUID(),
    changedPaths: ['grokSubscription'],
    expectedRevision: current,
    productionConfirmation: current,
    buildCandidate: (text) => {
      const raw = JSON.parse(text);
      raw.grokSubscription = {
        enabled: true,
        credentialRef: ref,
        credentialRefs: [ref],
        quotaCooldownMinutes: 60,
      };
      return JSON.stringify(raw, null, 2) + '\n';
    },
  };
}
async function setup() {
  const oauth = new GrokOAuthClient();
  const refresh = vi.spyOn(oauth, 'refresh').mockImplementation(async (old) => ({
    ...old,
    accessToken: 'fixture-new-access',
    refreshToken: 'fixture-new-refresh',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }));
  const manager = new GrokCredentialManager({
    vault: rig.vault,
    getConfig: () => rig.nodes[0].config.grokSubscription,
    oauthClient: oauth,
    requireRotationCoordinator: true,
  });
  manager.setCredentialRotationTransaction((ref, action) =>
    rig.publisher.withCredentialRotation(ref, action),
  );
  const candidate = await manager.persistLogin({
    ...grokTokens('production-fixture'),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  });
  await rig.service.mutate(registration(candidate.credentialRef));
  return { manager, refresh, ref: candidate.credentialRef };
}
describe('Grok signed dual-consumer publication T20-T22', () => {
  it('registers without a prior root and advances only credential identity after a protected refresh', async () => {
    const f = await setup();
    const disk = readFileSync(rig.configPath, 'utf8');
    const before = readPublication(rig.configPath)!;
    expect(rig.nodes.every((n) => n.config.grokSubscription?.credentialRef === f.ref)).toBe(true);
    const token = await f.manager.getCredentials();
    expect(token.generation).toBe(2);
    expect(f.refresh).toHaveBeenCalledOnce();
    const after = readPublication(rig.configPath)!;
    expect(after.phase).toBe('committed');
    expect(after.identity.digest).toBe(before.identity.digest);
    expect(after.identity.credentialVersionDigest).not.toBe(
      before.identity.credentialVersionDigest,
    );
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(readFileSync(rig.configPath, 'utf8')).toBe(disk);
    expect(rig.nodes.every((n) => n.view.isExecutionAllowed())).toBe(true);
    expect(JSON.stringify(after)).not.toMatch(
      /fixture-new-access|fixture-new-refresh|production-fixture@example/,
    );
  });
  it('keeps a consumed refresh fenced when a Worker receipt is missing and recovers without refreshing twice', async () => {
    const f = await setup();
    rig.blockedPhases.add('runtime-worker:applying');
    await expect(f.manager.getCredentials()).rejects.toThrow();
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(readPublication(rig.configPath)!.phase).toBe('recovery_required');
    expect(rig.nodes.every((n) => !n.view.isExecutionAllowed())).toBe(true);
    rig.blockedPhases.clear();
    await rig.publisher.recover();
    const token = await f.manager.getCredentials();
    expect(token.generation).toBe(2);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(readPublication(rig.configPath)!.phase).toBe('committed');
    expect(rig.nodes.every((n) => n.view.isExecutionAllowed())).toBe(true);
  });
  it('rolls back rejected registration without changing the original model or publishing a candidate', async () => {
    const manager = new GrokCredentialManager({
      vault: rig.vault,
      getConfig: () => rig.nodes[0].config.grokSubscription,
    });
    const candidate = await manager.persistLogin(grokTokens());
    rig.blockedPhases.add('runtime-worker:applying');
    await expect(rig.service.mutate(registration(candidate.credentialRef))).rejects.toThrow();
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
    expect(rig.nodes.every((n) => n.config.grokSubscription === undefined)).toBe(true);
    expect(readPublication(rig.configPath)!.phase).toBe('committed');
    await manager.discardLoginCandidate(candidate.credentialRef);
    await expect(
      rig.vault.getSecret(candidate.credentialRef, {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:grok_subscription_oauth:read'],
      }),
    ).rejects.toThrow();
  });
  it('checks confirmation and operation scope before changing any credential or model configuration', async () => {
    const candidate = await new GrokCredentialManager({
      vault: rig.vault,
      getConfig: () => undefined,
    }).persistLogin(grokTokens());
    const request = registration(candidate.credentialRef);
    const build = vi.fn(request.buildCandidate);
    await expect(
      rig.service.mutate({ ...request, productionConfirmation: undefined, buildCandidate: build }),
    ).rejects.toThrow();
    expect(build).not.toHaveBeenCalled();
    await expect(
      rig.service.mutate({
        ...registration(candidate.credentialRef),
        buildCandidate: (text) => {
          const raw = JSON.parse(text);
          raw.codexSubscription = { enabled: false };
          return JSON.stringify(raw);
        },
      }),
    ).rejects.toThrow(/范围|其他配置/);
    expect(readFileSync(rig.configPath, 'utf8')).toBe(rig.before);
  });
});

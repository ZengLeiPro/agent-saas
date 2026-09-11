import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createSourceProof,
  validateSourceAuthority,
  collectSourceAuthority,
} from './staging-source-authority.mjs';
import { validateRun } from './staging-deployment-binding.mjs';
import { assertArchivedDatabaseEvidence } from './verify-migration-readback.mjs';
import { seal } from './automatic-release-contract.mjs';
import {
  sourceFixture,
  repository,
  sha,
  iso,
  digest,
} from './fixtures/automatic-release-fixture.mjs';

function fixture() {
  const f = sourceFixture();
  f.context.run.status = 'completed';
  f.context.run.conclusion = 'success';
  const proof = createSourceProof(f);
  f.deployment.payload.automaticSource = { digest: proof.digest, stepId: proof.stepId };
  const bundle = { proof, authority: f.authority, ...f.context, deployment: f.deployment };
  const options = {
    manifest: f.manifest,
    run: f.context.run,
    deployment: f.deployment,
    repository,
  };
  return { ...f, bundle, options };
}
test('explicit refreshed source delegation separates source SHA from verified engine SHA', () => {
  const f = fixture();
  assert.equal(validateSourceAuthority(f.bundle, f.options), sha(15));
  assert.notEqual(f.options.run.head_sha, f.manifest.releaseSha);
});
test('ordinary Staging run still requires exact source SHA without a delegation', () => {
  const f = fixture();
  const binding = { stagingRunId: '701', stagingRunAttempt: '1', sourceSha: f.manifest.releaseSha };
  assert.throws(() => validateRun(f.options.run, binding, repository, 'bound_run'));
});
test('strict migration readback can use only the validated source delegation, never an engine override', () => {
  const f = fixture();
  const evidence = {
    schemaVersion: 1,
    releaseId: f.manifest.releaseId,
    manifestDigest: f.manifest.digest,
    environment: 'staging',
    planDigest: f.manifest.migrationPlan.planDigest,
    status: 'not_required',
    checks: [],
    observedAt: iso(f.now),
  };
  const args = {
    manifest: f.manifest,
    evidence,
    run: f.options.run,
    runId: '701',
    runAttempt: '1',
    repository,
    now: f.now + 1000,
  };
  assert.throws(() => assertArchivedDatabaseEvidence(args));
  assert.equal(
    assertArchivedDatabaseEvidence({ ...args, sourceAuthority: f.bundle }).status,
    'passed',
  );
  assert.throws(() =>
    assertArchivedDatabaseEvidence({ ...args, sourceAuthority: { engineSha: sha(15) } }),
  );
});
for (const [name, mutate] of Object.entries({
  'missing direct GitHub deployment marker': (f) => {
    delete f.deployment.payload.automaticSource;
  },
  'wrong parent record': (f) => {
    f.bundle.requestRecord.id = 999;
  },
  'wrong step record': (f) => {
    f.bundle.stepRecord.id = 999;
  },
  'altered source': (f) => {
    f.bundle.proof.sourceSha = sha(9);
  },
  'arbitrary resealed source': (f) => {
    const { digest: unused, ...p } = f.bundle.proof;
    f.bundle.proof = seal({ ...p, sourceSha: sha(9) });
    f.deployment.payload.automaticSource.digest = f.bundle.proof.digest;
  },
  'different workflow engine': (f) => {
    f.options.run.head_sha = sha(14);
  },
  'wrong repository': (f) => {
    f.options.run.repository.full_name = 'foreign/repo';
  },
  rerun: (f) => {
    f.options.run.run_attempt = 2;
  },
  'different target baseline': (f) => {
    f.bundle.authority.productionBaseline.api.sourceSha = sha(9);
  },
  'unknown evidence digest': (f) => {
    f.bundle.authority.evidenceDigest = digest(9);
  },
  'historical baseline fallback': (f) => {
    f.bundle.authority.baselineObservation = { kind: 'last_committed' };
  },
  'wrong deployment sha': (f) => {
    f.deployment.sha = sha(9);
  },
  'wrong manifest': (f) => {
    f.manifest.releaseId = 'rc-20260911-999';
  },
  'different Staging child': (f) => {
    f.options.run.id = 999;
  },
  'different parent verification time': (f) => {
    f.bundle.requestRecord.payload.target.verifiedAt = '2099-01-01T00:00:00Z';
  },
}))
  test(`source delegation rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateSourceAuthority(f.bundle, f.options));
  });

test('collector fetches independent parent/step records with GET only and persists full binding', async () => {
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'source-delegation-'));
  try {
    await mkdir(join(dir, 'attempt-evidence'));
    for (const [name, value] of Object.entries({
      'deployment.json': f.deployment,
      'staging-attempt.json': f.options.run,
      'attempt-evidence/staging-source-binding.json': f.bundle.proof,
      'attempt-evidence/authoritative-evidence.json': f.authority,
    }))
      await writeFile(join(dir, name), JSON.stringify(value));
    const calls = [];
    const client = {
      repository,
      api: async (path, body) => {
        assert.equal(body, undefined);
        calls.push(path);
        return {
          'deployments/602': f.context.stepRecord,
          'deployments/601': f.context.requestRecord,
          'actions/runs/501': f.context.parentRun,
        }[path];
      },
    };
    const bundle = await collectSourceAuthority(client, dir, f.manifest);
    assert.equal(validateSourceAuthority(bundle, f.options), sha(15));
    assert.deepEqual(calls, ['deployments/602', 'deployments/601', 'actions/runs/501']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

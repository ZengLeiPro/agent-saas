import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import test from 'node:test';
import {
  EVIDENCE_SCHEMA,
  SUBMIT_SCHEMA,
  ROLLOUT_SCHEMA,
  canonicalDigest,
  sealEnvelope,
  validateBuildEvidence,
  validateSubmitReceipt,
  validateRolloutReceipt,
} from './mobile-release-evidence.mjs';

const seed = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
const options = { publicKeys: { 'fixture-2026': publicKey } };
const hash = (char) => `sha256:${char.repeat(64)}`;
const approval = (environment, n = 1) => ({
  environment,
  deploymentId: String(100 + n),
  runId: '5000',
  runAttempt: 1,
  protectionRulesSha256: hash('a'),
  approvedAt: '2026-09-01T06:00:00.000Z',
});
const provenance = (profile, artifactSha256) => ({
  id: `github:attestation:5000:${profile}`,
  artifactSha256,
  workflowRunId: '5000',
  commitOid: '1'.repeat(40),
});

function buildFixture() {
  const base = {
    schema: EVIDENCE_SCHEMA,
    repo: 'kaiyan/agent-saas',
    ref: 'refs/tags/mobile-v1.9.5-rc.1',
    tag: 'mobile-v1.9.5-rc.1',
    commitOid: '1'.repeat(40),
    reviewedHeadOid: '1'.repeat(40),
    lockSha256: hash('2'),
    manifestSha256: hash('3'),
    toolchain: {
      node: '22.23.1',
      pnpm: '10.18.3',
      easCli: '18.1.0',
      xcode: '16.4',
      iosRunner: 'macos-15',
      iosImage: 'macos-sequoia-15.6-xcode-16.4',
      androidRunner: 'ubuntu-24.04',
      androidImage: 'ubuntu-24.04-jdk-17-ndk-r27b-sdk-55',
    },
    approval: approval('mobile-build-production'),
    buildStartedAt: '2026-09-01T06:01:00.000Z',
    buildCompletedAt: '2026-09-01T06:09:00.000Z',
    profiles: [],
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
  };
  for (const [index, profile] of ['ios-store', 'android-store', 'android-enterprise'].entries()) {
    const artifactSha256 = hash(String(index + 4));
    base.profiles.push({
      profile,
      appId: 'com.agentsaas.mobile',
      version: '1.9.5',
      buildNumber: profile === 'ios-store' ? 85 : null,
      versionCode: profile === 'ios-store' ? null : 109050085,
      easBuildId: `10000000-0000-4000-8000-00000000000${index + 1}`,
      artifactSha256,
      size: 1000 + index,
      signerFingerprint: hash(String(index + 7)),
      permissionsSha256: hash('b'),
      sbom: { spdxSha256: hash('c'), cycloneDxSha256: hash('d') },
      provenance: provenance(profile, artifactSha256),
    });
  }
  return sealEnvelope(base, { privateKey, keyId: 'fixture-2026' });
}
function submitFixture(build = buildFixture()) {
  return sealEnvelope(
    {
      schema: SUBMIT_SCHEMA,
      buildEvidenceDigest: build.canonicalDigest,
      profile: 'android-store',
      commitOid: build.commitOid,
      artifactSha256: build.profiles[1].artifactSha256,
      storeBuildId: 'play-build-109050085',
      submissionId: 'eas-submission-fixture-1',
      submittedAt: '2026-09-01T07:00:00.000Z',
      approval: approval('mobile-submit-android-store', 2),
      nonce: 'BBBBBBBBBBBBBBBBBBBBBB',
    },
    { privateKey, keyId: 'fixture-2026' },
  );
}

for (const profile of ['ios-store', 'android-store', 'android-enterprise']) {
  test(`M60-04 valid ${profile} fixture is present in one same-SHA evidence set`, () => {
    const fixture = buildFixture();
    validateBuildEvidence(fixture, options);
    assert.equal(
      fixture.profiles.find((entry) => entry.profile === profile).provenance.commitOid,
      fixture.commitOid,
    );
  });
}

const mutations = [
  [
    'tampered digest',
    (v) => {
      v.lockSha256 = hash('f');
    },
    /canonicalDigest mismatch/,
  ],
  [
    'cross SHA',
    (v) => {
      v.profiles[0].provenance.commitOid = '2'.repeat(40);
    },
    /provenance.commitOid mismatch/,
  ],
  [
    'wrong app',
    (v) => {
      v.profiles[2].appId = 'com.attacker.app';
    },
    /appId mismatch/,
  ],
  [
    'wrong version',
    (v) => {
      v.profiles[1].version = '9.9.9';
    },
    /version mismatch/,
  ],
  [
    'debug signer',
    (v) => {
      v.profiles[0].signerFingerprint = 'debug';
    },
    /signerFingerprint is invalid|debug signer/,
  ],
  [
    'missing approval',
    (v) => {
      delete v.approval;
    },
    /keys must be exactly/,
  ],
  [
    'replayed EAS id',
    (v) => {
      v.profiles[2].easBuildId = v.profiles[1].easBuildId;
    },
    /replayed across profiles/,
  ],
  [
    'toolchain drift',
    (v) => {
      v.toolchain.node = '22';
    },
    /toolchain.node mismatch/,
  ],
];
for (const [name, mutate, expected] of mutations)
  test(`M60-04 rejects ${name}`, () => {
    const value = buildFixture();
    mutate(value);
    assert.throws(() => validateBuildEvidence(value, options), expected);
  });

test('M60-04 rejects replay ledger EAS ID and nonce', () => {
  const value = buildFixture();
  assert.throws(
    () =>
      validateBuildEvidence(value, {
        ...options,
        replay: { easBuildIds: new Set([value.profiles[0].easBuildId]) },
      }),
    /was replayed/,
  );
  assert.throws(
    () => validateBuildEvidence(value, { ...options, replay: { nonces: new Set([value.nonce]) } }),
    /nonce was replayed/,
  );
});

test('M60-04 submit accepts only the artifact bound by build evidence', () => {
  const build = buildFixture();
  const receipt = submitFixture(build);
  validateSubmitReceipt(receipt, { ...options, buildEvidence: build });
  const changed = structuredClone(receipt);
  changed.artifactSha256 = hash('e');
  const resealed = sealEnvelope(changed, { privateKey, keyId: 'fixture-2026' });
  assert.throws(
    () => validateSubmitReceipt(resealed, { ...options, buildEvidence: build }),
    /submit artifactSha256 mismatch/,
  );
});

test('M60-04 rollout boundary accepts submit receipt and pause/rollback command contract', () => {
  const build = buildFixture();
  const submit = submitFixture(build);
  for (const command of ['start', 'pause', 'resume', 'rollback']) {
    const rollout = sealEnvelope(
      {
        schema: ROLLOUT_SCHEMA,
        submitReceiptDigest: submit.canonicalDigest,
        profile: submit.profile,
        command,
        storeBuildId: submit.storeBuildId,
        rolloutId: `rollout-${command}`,
        executedAt: '2026-09-01T08:00:00.000Z',
        approval: approval(`mobile-rollout-${submit.profile}`, 3),
        nonce: `${command.padEnd(22, 'X')}`,
      },
      { privateKey, keyId: 'fixture-2026' },
    );
    validateRolloutReceipt(rollout, { ...options, buildEvidence: build, submitReceipt: submit });
  }
});

test('M60-04 canonical digest is stable and excludes only digest/signature envelope', () => {
  const fixture = buildFixture();
  assert.equal(canonicalDigest(fixture), fixture.canonicalDigest);
});

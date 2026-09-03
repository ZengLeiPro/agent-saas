#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EVIDENCE_SCHEMA = 'https://agent.kaiyan.net/schemas/mobile-release-evidence-v1';
export const SUBMIT_SCHEMA = 'https://agent.kaiyan.net/schemas/mobile-submit-receipt-v1';
export const ROLLOUT_SCHEMA = 'https://agent.kaiyan.net/schemas/mobile-rollout-receipt-v1';
export const PROFILES = Object.freeze(['ios-store', 'android-store', 'android-enterprise']);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40}$/u;
const EAS_ID = /^[0-9a-f-]{8,64}$/iu;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const APP_ID = /^[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)+$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const TOOLCHAIN = Object.freeze({
  node: '22.23.1',
  pnpm: '10.18.3',
  easCli: '18.1.0',
  xcode: '16.4',
  iosRunner: 'macos-15',
  iosImage: 'macos-sequoia-15.6-xcode-16.4',
  androidRunner: 'ubuntu-24.04',
  androidImage: 'ubuntu-24.04-jdk-17-ndk-r27b-sdk-55',
});

function fail(message) {
  throw new Error(`[M60-04] ${message}`);
}
function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  return value;
}
function exact(value, path, keys) {
  record(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0'))
    fail(`${path} keys must be exactly ${expected.join(', ')}`);
}
function text(value, path, pattern, maximum = 512) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  )
    fail(`${path} is invalid`);
  return value;
}
function integer(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${path} must be a positive integer`);
  return value;
}
function digest(value, path) {
  return text(value, path, SHA256, 71);
}
function oid(value, path) {
  return text(value, path, OID, 40);
}
function iso(value, path) {
  return text(value, path, ISO, 24);
}
function same(value, expected, path) {
  if (value !== expected) fail(`${path} mismatch`);
}

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('canonical JSON only permits safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    fail('canonical JSON contains unsupported value');
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function unsignedEnvelope(document) {
  const copy = structuredClone(document);
  delete copy.canonicalDigest;
  delete copy.signature;
  return copy;
}

export function canonicalDigest(document) {
  return sha256(canonicalize(unsignedEnvelope(document)));
}
function signaturePayload(document) {
  return Buffer.from(
    `agent-saas-mobile-release-v1\0${document.schema}\0${document.canonicalDigest}\0${document.nonce}`,
    'utf8',
  );
}

export function sealEnvelope(document, { privateKey, keyId }) {
  const sealed = structuredClone(document);
  delete sealed.canonicalDigest;
  delete sealed.signature;
  text(sealed.nonce, 'nonce', NONCE, 128);
  sealed.canonicalDigest = canonicalDigest(sealed);
  sealed.signature = {
    algorithm: 'Ed25519',
    keyId: text(keyId, 'keyId', /^[A-Za-z0-9._-]{1,64}$/u, 64),
    value: sign(
      null,
      signaturePayload(sealed),
      privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey),
    ).toString('base64'),
  };
  return sealed;
}

function validateEnvelope(document, options = {}) {
  exact(document.signature, 'signature', ['algorithm', 'keyId', 'value']);
  same(document.signature.algorithm, 'Ed25519', 'signature.algorithm');
  text(document.signature.keyId, 'signature.keyId', /^[A-Za-z0-9._-]{1,64}$/u, 64);
  text(document.signature.value, 'signature.value', BASE64, 128);
  text(document.nonce, 'nonce', NONCE, 128);
  digest(document.canonicalDigest, 'canonicalDigest');
  same(document.canonicalDigest, canonicalDigest(document), 'canonicalDigest');
  const trustedKey = options.publicKeys?.[document.signature.keyId];
  if (!trustedKey) fail(`signature key ${document.signature.keyId} is not trusted`);
  let valid = false;
  try {
    const publicKey = trustedKey?.type === 'public' ? trustedKey : createPublicKey(trustedKey);
    valid = verify(
      null,
      signaturePayload(document),
      publicKey,
      Buffer.from(document.signature.value, 'base64'),
    );
  } catch {
    fail('signature public key is invalid');
  }
  if (!valid) fail('signature verification failed');
  const replay = options.replay ?? {};
  if (replay.nonces?.has(document.nonce)) fail('nonce was replayed');
  if (replay.canonicalDigests?.has(document.canonicalDigest))
    fail('canonical evidence digest was replayed');
}

function validateApproval(approval, expectedEnvironment) {
  exact(approval, 'approval', [
    'environment',
    'deploymentId',
    'runId',
    'runAttempt',
    'protectionRulesSha256',
    'approvedAt',
  ]);
  same(approval.environment, expectedEnvironment, 'approval.environment');
  text(approval.deploymentId, 'approval.deploymentId', /^[1-9][0-9]{0,19}$/u, 20);
  text(approval.runId, 'approval.runId', /^[1-9][0-9]{0,19}$/u, 20);
  integer(approval.runAttempt, 'approval.runAttempt');
  digest(approval.protectionRulesSha256, 'approval.protectionRulesSha256');
  iso(approval.approvedAt, 'approval.approvedAt');
}

function validateToolchain(toolchain) {
  exact(toolchain, 'toolchain', Object.keys(TOOLCHAIN));
  for (const [key, expected] of Object.entries(TOOLCHAIN))
    same(toolchain[key], expected, `toolchain.${key}`);
}

function validateProfile(profile, root) {
  exact(profile, `profiles.${profile.profile ?? '?'}`, [
    'profile',
    'appId',
    'version',
    'buildNumber',
    'versionCode',
    'easBuildId',
    'artifactSha256',
    'size',
    'signerFingerprint',
    'permissionsSha256',
    'sbom',
    'provenance',
  ]);
  if (!PROFILES.includes(profile.profile)) fail(`unsupported profile ${profile.profile}`);
  text(profile.appId, `${profile.profile}.appId`, APP_ID, 255);
  text(profile.version, `${profile.profile}.version`, VERSION, 64);
  if (profile.profile === 'ios-store') {
    integer(profile.buildNumber, 'ios-store.buildNumber');
    if (profile.versionCode !== null) fail('ios-store.versionCode must be null');
  } else {
    if (profile.buildNumber !== null) fail(`${profile.profile}.buildNumber must be null`);
    integer(profile.versionCode, `${profile.profile}.versionCode`);
  }
  text(profile.easBuildId, `${profile.profile}.easBuildId`, EAS_ID, 64);
  digest(profile.artifactSha256, `${profile.profile}.artifactSha256`);
  integer(profile.size, `${profile.profile}.size`);
  text(
    profile.signerFingerprint,
    `${profile.profile}.signerFingerprint`,
    /^sha256:[0-9a-f]{64}$/u,
    71,
  );
  if (/debug|androiddebugkey/iu.test(profile.signerFingerprint))
    fail(`${profile.profile} uses a debug signer`);
  digest(profile.permissionsSha256, `${profile.profile}.permissionsSha256`);
  exact(profile.sbom, `${profile.profile}.sbom`, ['spdxSha256', 'cycloneDxSha256']);
  digest(profile.sbom.spdxSha256, `${profile.profile}.sbom.spdxSha256`);
  digest(profile.sbom.cycloneDxSha256, `${profile.profile}.sbom.cycloneDxSha256`);
  exact(profile.provenance, `${profile.profile}.provenance`, [
    'id',
    'artifactSha256',
    'workflowRunId',
    'commitOid',
  ]);
  text(
    profile.provenance.id,
    `${profile.profile}.provenance.id`,
    /^[A-Za-z0-9:._/-]{8,256}$/u,
    256,
  );
  same(
    profile.provenance.artifactSha256,
    profile.artifactSha256,
    `${profile.profile}.provenance.artifactSha256`,
  );
  same(
    profile.provenance.workflowRunId,
    root.approval.runId,
    `${profile.profile}.provenance.workflowRunId`,
  );
  same(profile.provenance.commitOid, root.commitOid, `${profile.profile}.provenance.commitOid`);
  return profile;
}

export function validateBuildEvidence(document, options = {}) {
  exact(document, 'evidence', [
    'schema',
    'repo',
    'ref',
    'tag',
    'commitOid',
    'reviewedHeadOid',
    'lockSha256',
    'manifestSha256',
    'toolchain',
    'approval',
    'buildStartedAt',
    'buildCompletedAt',
    'profiles',
    'nonce',
    'canonicalDigest',
    'signature',
  ]);
  same(document.schema, EVIDENCE_SCHEMA, 'schema');
  text(document.repo, 'repo', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 200);
  text(document.ref, 'ref', /^refs\/(tags|heads)\/[A-Za-z0-9._/-]+$/u, 512);
  if (document.tag !== null)
    text(document.tag, 'tag', /^mobile-v[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*$/u, 128);
  oid(document.commitOid, 'commitOid');
  oid(document.reviewedHeadOid, 'reviewedHeadOid');
  same(document.reviewedHeadOid, document.commitOid, 'reviewedHeadOid');
  digest(document.lockSha256, 'lockSha256');
  digest(document.manifestSha256, 'manifestSha256');
  validateToolchain(document.toolchain);
  validateApproval(document.approval, 'mobile-build-production');
  iso(document.buildStartedAt, 'buildStartedAt');
  iso(document.buildCompletedAt, 'buildCompletedAt');
  if (Date.parse(document.buildCompletedAt) < Date.parse(document.buildStartedAt))
    fail('buildCompletedAt predates buildStartedAt');
  if (
    !Array.isArray(document.profiles) ||
    document.profiles.length < 1 ||
    document.profiles.length > PROFILES.length
  )
    fail('profiles must contain between one and three entries');
  const profiles = document.profiles.map((profile) =>
    validateProfile(record(profile, 'profile'), document),
  );
  const names = profiles.map(({ profile }) => profile);
  if (new Set(names).size !== names.length)
    fail('release profiles must be unique');
  const easIds = profiles.map(({ easBuildId }) => easBuildId);
  if (new Set(easIds).size !== easIds.length) fail('EAS build ID was replayed across profiles');
  for (const id of easIds)
    if (options.replay?.easBuildIds?.has(id)) fail(`EAS build ID ${id} was replayed`);
  const baseline = profiles[0];
  for (const profile of profiles) {
    same(profile.appId, baseline.appId, `${profile.profile}.appId`);
    same(profile.version, baseline.version, `${profile.profile}.version`);
  }
  const androidStore = profiles.find(({ profile }) => profile === 'android-store');
  const androidEnterprise = profiles.find(({ profile }) => profile === 'android-enterprise');
  if (androidStore && androidEnterprise) {
    same(androidStore.versionCode, androidEnterprise.versionCode, 'Android versionCode');
  }
  validateEnvelope(document, options);
  return document;
}

export function validateSubmitReceipt(document, options = {}) {
  exact(document, 'submit receipt', [
    'schema',
    'buildEvidenceDigest',
    'profile',
    'commitOid',
    'artifactSha256',
    'storeBuildId',
    'submissionId',
    'submittedAt',
    'approval',
    'nonce',
    'canonicalDigest',
    'signature',
  ]);
  same(document.schema, SUBMIT_SCHEMA, 'schema');
  digest(document.buildEvidenceDigest, 'buildEvidenceDigest');
  if (!PROFILES.includes(document.profile)) fail('submit profile is invalid');
  oid(document.commitOid, 'commitOid');
  digest(document.artifactSha256, 'artifactSha256');
  text(document.storeBuildId, 'storeBuildId', /^[A-Za-z0-9._:-]{1,128}$/u, 128);
  text(document.submissionId, 'submissionId', /^[A-Za-z0-9._:-]{1,256}$/u, 256);
  iso(document.submittedAt, 'submittedAt');
  validateApproval(document.approval, `mobile-submit-${document.profile}`);
  const build = options.buildEvidence;
  if (!build) fail('build evidence is required to validate a submit receipt');
  validateBuildEvidence(build, { publicKeys: options.publicKeys });
  same(document.buildEvidenceDigest, build.canonicalDigest, 'buildEvidenceDigest');
  same(document.commitOid, build.commitOid, 'submit commitOid');
  const source = build.profiles.find(({ profile }) => profile === document.profile);
  same(document.artifactSha256, source.artifactSha256, 'submit artifactSha256');
  validateEnvelope(document, options);
  return document;
}

export function validateRolloutReceipt(document, options = {}) {
  exact(document, 'rollout receipt', [
    'schema',
    'submitReceiptDigest',
    'profile',
    'command',
    'storeBuildId',
    'rolloutId',
    'executedAt',
    'approval',
    'nonce',
    'canonicalDigest',
    'signature',
  ]);
  same(document.schema, ROLLOUT_SCHEMA, 'schema');
  digest(document.submitReceiptDigest, 'submitReceiptDigest');
  if (!PROFILES.includes(document.profile)) fail('rollout profile is invalid');
  if (!['start', 'pause', 'resume', 'rollback'].includes(document.command))
    fail('rollout command is invalid');
  text(document.storeBuildId, 'storeBuildId', /^[A-Za-z0-9._:-]{1,128}$/u, 128);
  text(document.rolloutId, 'rolloutId', /^[A-Za-z0-9._:-]{1,256}$/u, 256);
  iso(document.executedAt, 'executedAt');
  validateApproval(document.approval, `mobile-rollout-${document.profile}`);
  const submit = options.submitReceipt;
  if (!submit) fail('submit receipt is required to validate a rollout receipt');
  validateSubmitReceipt(submit, {
    publicKeys: options.publicKeys,
    buildEvidence: options.buildEvidence,
  });
  same(document.submitReceiptDigest, submit.canonicalDigest, 'submitReceiptDigest');
  same(document.profile, submit.profile, 'rollout profile');
  same(document.storeBuildId, submit.storeBuildId, 'rollout storeBuildId');
  validateEnvelope(document, options);
  return document;
}

export function loadPublicKeys(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  exact(parsed, 'public key store', ['schema', 'keys']);
  same(parsed.schema, 'agent-saas-mobile-release-public-keys-v1', 'public key store schema');
  record(parsed.keys, 'public key store keys');
  return parsed.keys;
}

function args(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) parsed._.push(argv[i]);
    else {
      const key = argv[i].slice(2);
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) parsed[key] = true;
      else parsed[key] = argv[++i];
    }
  }
  return parsed;
}

async function main() {
  const input = args(process.argv.slice(2));
  const command = input._[0];
  if (!['validate-build', 'validate-submit', 'validate-rollout', 'seal'].includes(command))
    fail('expected validate-build, validate-submit, validate-rollout, or seal');
  const document = JSON.parse(readFileSync(resolve(text(input.input, '--input')), 'utf8'));
  if (command === 'seal') {
    const keyPath = resolve(text(input['private-key'], '--private-key'));
    const sealed = sealEnvelope(document, {
      privateKey: readFileSync(keyPath),
      keyId: input['key-id'],
    });
    writeFileSync(resolve(text(input.output, '--output')), `${canonicalize(sealed)}\n`, {
      mode: 0o600,
    });
    return;
  }
  const publicKeys = loadPublicKeys(resolve(text(input['public-keys'], '--public-keys')));
  let replay;
  if (input['replay-ledger']) {
    const ledger = JSON.parse(readFileSync(resolve(input['replay-ledger']), 'utf8'));
    exact(ledger, 'replay ledger', ['schema', 'nonces', 'canonicalDigests', 'easBuildIds']);
    same(ledger.schema, 'agent-saas-mobile-release-replay-ledger-v1', 'replay ledger schema');
    for (const key of ['nonces', 'canonicalDigests', 'easBuildIds'])
      if (!Array.isArray(ledger[key])) fail(`replay ledger ${key} must be an array`);
    replay = {
      nonces: new Set(ledger.nonces),
      canonicalDigests: new Set(ledger.canonicalDigests),
      easBuildIds: new Set(ledger.easBuildIds),
    };
  }
  if (command === 'validate-build') validateBuildEvidence(document, { publicKeys, replay });
  if (command === 'validate-submit') {
    const buildEvidence = JSON.parse(
      readFileSync(resolve(text(input['build-evidence'], '--build-evidence')), 'utf8'),
    );
    validateSubmitReceipt(document, { publicKeys, replay, buildEvidence });
  }
  if (command === 'validate-rollout') {
    const buildEvidence = JSON.parse(
      readFileSync(resolve(text(input['build-evidence'], '--build-evidence')), 'utf8'),
    );
    const submitReceipt = JSON.parse(
      readFileSync(resolve(text(input['submit-receipt'], '--submit-receipt')), 'utf8'),
    );
    validateRolloutReceipt(document, { publicKeys, replay, buildEvidence, submitReceipt });
  }
  process.stdout.write(`M60-04 ${command} passed digest=${document.canonicalDigest}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

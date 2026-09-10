import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { requireId, requireSha } from './ios-actions-policy.mjs';

export function readJson(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected a regular JSON file: ${basename(path)}`);
  assert.ok(stat.size <= 128 * 1024, 'Release metadata exceeds its size bound');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function hashFile(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected a regular file: ${basename(path)}`);
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return { sha256: hash.digest('hex'), size: stat.size };
}

function expectedFiles(manifest) {
  const version = manifest.version.marketingVersion;
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/u, 'Unsafe marketing version');
  const ipa = `AgentSaaS-${version}.ipa`;
  return [ipa, `${ipa}.source.json`, `${ipa}.verification.json`];
}

function assertBuildNumber(value, manifest) {
  const text = String(value ?? '');
  assert.match(text, /^[1-9][0-9]*(?:\.[0-9]+){0,2}$/u, 'Invalid iOS build number');
  assert.equal(text.split('.')[0], String(manifest.version.iosBuildNumber), 'iOS build number base mismatch');
  return text;
}

function assertSource(source, manifest, sourceSha) {
  assert.equal(source.profile, 'ios-store');
  assert.equal(source.sourceGitSha, requireSha(sourceSha));
  assert.equal(source.appId, manifest.identity.iosBundleIdentifier);
  assert.equal(source.iosTeamId, manifest.identity.iosAppleTeamId);
  assert.equal(source.iosAppGroup, manifest.identity.iosAppGroupIdentifier);
  assert.equal(source.version, manifest.version.marketingVersion);
  return assertBuildNumber(source.buildNumber, manifest);
}

export function sealBundle(root, context, approval, toolchain, ci) {
  const manifest = readJson(join(root, 'mobile/release-manifest.json'));
  const files = expectedFiles(manifest);
  const directory = join(root, 'mobile/builds');
  const buildNumber = assertSource(readJson(join(directory, files[1])), manifest, context.sourceSha);
  if (context.buildNumber) assert.equal(buildNumber, context.buildNumber, 'Workflow build number mismatch');
  const record = {
    schemaVersion: 1,
    kind: 'github-ios-build',
    repository: context.repository,
    sourceGitSha: requireSha(context.sourceSha),
    workflowGitSha: requireSha(context.workflowSha, 'workflow SHA'),
    buildRunId: requireId(context.buildRunId, 'build run ID'),
    buildRunAttempt: requireId(context.buildAttempt, 'build attempt'),
    appId: manifest.identity.iosBundleIdentifier,
    appStoreConnectAppId: manifest.identity.iosAscAppId,
    version: manifest.version.marketingVersion,
    buildNumber,
    lockSha256: hashFile(join(root, 'pnpm-lock.yaml')).sha256,
    manifestSha256: hashFile(join(root, 'mobile/release-manifest.json')).sha256,
    files: files.map((filename) => ({ filename, ...hashFile(join(directory, filename)) })),
    authorization: approval,
    ci,
    toolchain,
    createdAt: new Date().toISOString(),
  };
  // Never replace an earlier handoff. GitHub's artifact ID additionally binds
  // this record to the successful protected build job, not to user input.
  writeFileSync(join(directory, 'ios-release.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return record;
}

export function verifyBundle(root, expected) {
  const directory = join(root, 'mobile/builds');
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Unsafe builds directory');
  const record = readJson(join(directory, 'ios-release.json'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, 'github-ios-build');
  assert.equal(record.repository, expected.repository);
  assert.equal(record.sourceGitSha, requireSha(expected.sourceSha));
  assert.equal(record.workflowGitSha, requireSha(expected.workflowSha, 'workflow SHA'));
  assert.equal(record.buildRunId, requireId(expected.buildRunId, 'build run ID'));
  assert.equal(record.buildRunAttempt, requireId(expected.buildAttempt, 'build attempt'));
  const manifest = readJson(join(root, 'mobile/release-manifest.json'));
  const names = expectedFiles(manifest);
  assert.equal(record.appId, manifest.identity.iosBundleIdentifier);
  assert.equal(record.appStoreConnectAppId, manifest.identity.iosAscAppId);
  assert.equal(record.version, manifest.version.marketingVersion);
  assertBuildNumber(record.buildNumber, manifest);
  assert.equal(record.lockSha256, hashFile(join(root, 'pnpm-lock.yaml')).sha256, 'Lockfile digest changed');
  assert.equal(record.manifestSha256, hashFile(join(root, 'mobile/release-manifest.json')).sha256, 'Release manifest digest changed');
  assert.ok(Array.isArray(record.files));
  assert.deepEqual(record.files.map((file) => file.filename), names, 'Unexpected handoff file names');
  for (const file of record.files) {
    assert.match(file.sha256 ?? '', /^[0-9a-f]{64}$/u);
    const actual = hashFile(join(directory, file.filename));
    assert.equal(actual.sha256, file.sha256, `Artifact digest mismatch: ${file.filename}`);
    assert.equal(actual.size, file.size, `Artifact size mismatch: ${file.filename}`);
  }
  assert.equal(assertSource(readJson(join(directory, names[1])), manifest, expected.sourceSha), String(record.buildNumber));
  assert.equal(record.authorization?.environment, 'mobile-build-production');
  assert.equal(record.authorization?.authorization, 'workflow_dispatch');
  assert.match(record.authorization?.protectionRulesSha256 ?? '', /^[0-9a-f]{64}$/u);
  assert.ok(record.authorization?.actor, 'Missing build dispatch actor');
  assert.equal(record.ci?.sourceGitSha, expected.sourceSha, 'Missing same-source CI authority');
  return { record, ipaPath: join(directory, names[0]) };
}

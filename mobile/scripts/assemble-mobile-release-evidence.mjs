#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EVIDENCE_SCHEMA, PROFILES } from './mobile-release-evidence.mjs';
function fail(message) {
  throw new Error(`[M60-04] evidence assembly failed: ${message}`);
}
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) fail('invalid arguments');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
const input = args(process.argv.slice(2));
try {
  const root = resolve(input.dir);
  const shards = readdirSync(root)
    .filter((name) => name === 'release-profile.json')
    .map((name) => join(root, name));
  // download-artifact creates one directory per named profile artifact.
  const nested = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'release-profile.json'))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    });
  const paths = [...shards, ...nested];
  if (paths.length < 1 || paths.length > PROFILES.length)
    fail(`expected between one and three profile shards, found ${paths.length}`);
  const values = paths.map(json);
  const source = values[0].source;
  for (const value of values) {
    for (const field of [
      'repo',
      'ref',
      'tag',
      'commitOid',
      'reviewedHeadOid',
      'lockSha256',
      'manifestSha256',
    ])
      if (value.source[field] !== source[field]) fail(`cross-SHA/source mismatch at ${field}`);
  }
  const profiles = values
    .map(({ profile }) => profile)
    .sort((a, b) => PROFILES.indexOf(a) - PROFILES.indexOf(b));
  if (profiles.some((profile) => !PROFILES.includes(profile)))
    fail('unsupported release profile shard');
  if (new Set(profiles).size !== profiles.length)
    fail('duplicate release profile shard');
  const approvals = values.map(({ approval }) => approval);
  if (
    !approvals.every(
      (approval) =>
        approval.environment === 'mobile-build-production' &&
        approval.protectionRulesSha256 === approvals[0].protectionRulesSha256,
    )
  )
    fail('build approvals are absent or inconsistent');
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    repo: source.repo,
    ref: source.ref,
    tag: source.tag,
    commitOid: source.commitOid,
    reviewedHeadOid: source.reviewedHeadOid,
    lockSha256: source.lockSha256,
    manifestSha256: source.manifestSha256,
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
    approval: approvals[0],
    buildStartedAt: values.map(({ buildStartedAt }) => buildStartedAt).sort()[0],
    buildCompletedAt: values
      .map(({ buildCompletedAt }) => buildCompletedAt)
      .sort()
      .at(-1),
    profiles,
    nonce: randomBytes(24).toString('base64url'),
  };
  writeFileSync(resolve(input.output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `M60-04 evidence assembled profiles=${profiles.length} commit=${source.commitOid}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

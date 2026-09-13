#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

function hasIdentityFields(value, fields) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    fields.every((field) => typeof value[field] === 'string' && value[field].trim().length > 0)
  );
}

export function componentIdentityMatrix(components) {
  if (!components || typeof components !== 'object' || Array.isArray(components)) return null;
  const { web, api, runtimeWorker, acs } = components;
  if (
    ![web, api, runtimeWorker].every((value) =>
      hasIdentityFields(value, ['gitSha', 'artifactDigest']),
    ) ||
    !hasIdentityFields(acs, ['gitSha', 'orchestratorArtifactDigest', 'sandboxImageDigest'])
  )
    return null;
  return {
    web: { gitSha: web.gitSha, artifactDigest: web.artifactDigest },
    api: { gitSha: api.gitSha, artifactDigest: api.artifactDigest },
    runtimeWorker: {
      gitSha: runtimeWorker.gitSha,
      artifactDigest: runtimeWorker.artifactDigest,
    },
    acs: {
      gitSha: acs.gitSha,
      orchestratorArtifactDigest: acs.orchestratorArtifactDigest,
      sandboxImageDigest: acs.sandboxImageDigest,
    },
  };
}

// Observation must happen even after compensation. This is a WRITE gate only:
// retain an unknown live snapshot for reconciliation, but never bless it as the
// trusted baseline or mistake a healthy old App for the requested target App.
export function verifyPromotionObservation(manifest, before, live) {
  const project = (components) => componentIdentityMatrix(components);
  const previous = project(before?.components);
  const observed = project(live?.components);
  const target = project(
    Object.fromEntries(
      Object.entries(manifest?.components ?? {}).map(([name, value]) => [
        name,
        { ...value, gitSha: value.sourceSha },
      ]),
    ),
  );
  for (const matrix of [previous, observed, target]) {
    assert(matrix, 'Production observation has an incomplete component matrix');
    for (const component of Object.values(matrix)) {
      assert(SHA_PATTERN.test(component.gitSha), 'Production observation has an invalid source');
      for (const [key, value] of Object.entries(component)) {
        if (key !== 'gitSha')
          assert(DIGEST_PATTERN.test(value), 'Production observation has an invalid digest');
      }
    }
  }
  assert(
    live.schemaVersion === 1 && live.environment === 'production',
    'Production observation has the wrong environment',
  );
  assert(
    live.configIdentity?.status === 'consistent',
    'Production observation lacks consistent ConfigIdentity',
  );
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const name of Object.keys(target)) {
    const action = manifest.components[name].action;
    assert(['keep', 'deploy'].includes(action), 'Invalid component action');
    assert(
      action !== 'keep' || same(target[name], previous[name]),
      'Kept component disagrees with baseline',
    );
  }
  assert(
    manifest.components.api.action === manifest.components.runtimeWorker.action,
    'App actions disagree',
  );
  const components = {};
  for (const [scope, names] of Object.entries({
    acs: ['acs'],
    app: ['api', 'runtimeWorker'],
    web: ['web'],
  })) {
    const atBefore = names.every((name) => same(observed[name], previous[name]));
    const atTarget = names.every((name) => same(observed[name], target[name]));
    assert(
      atBefore || atTarget,
      `Unknown or split ${scope} identity; observation retained but identity commit refused`,
    );
    components[scope] = atTarget ? 'target' : 'before';
  }
  return { schemaVersion: 1, components, targetMatch: same(observed, target) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert(args.length === 3, 'usage: verify-promotion-observation.mjs <manifest> <before> <live>');
  const result = verifyPromotionObservation(
    ...args.map((path) => JSON.parse(readFileSync(path, 'utf8'))),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJson } from './artifact-lib.mjs';

export function summarizeStagingState({ manifest, before, observed, publicWebPassed }) {
  const components = {
    api: observed.host?.api ?? null,
    runtimeWorker: observed.host?.runtimeWorker ?? null,
    web: observed.web
      ? {
          releaseId: observed.web.releaseId,
          sourceSha: observed.web.releaseSha,
          artifactDigest: observed.web.webDigest,
        }
      : null,
    acs: observed.acs
      ? {
          releaseId: observed.acs.releaseId,
          sourceSha: observed.acs.sourceSha,
          artifactDigest: observed.acs.orchestratorArtifactDigest,
          sandboxImageDigest: observed.acs.sandboxImageDigest,
        }
      : null,
  };
  const known = Object.values(components).every(
    (value) => value?.releaseId && value.sourceSha && value.artifactDigest,
  );
  const target =
    known &&
    Object.entries(components).every(
      ([name, value]) =>
        value.releaseId === manifest.releaseId &&
        value.sourceSha === manifest.components[name].sourceSha &&
        value.artifactDigest ===
          (manifest.components[name].artifactDigest ??
            manifest.components[name].orchestratorArtifactDigest) &&
        (name !== 'acs' || value.sandboxImageDigest === manifest.components.acs.sandboxImageDigest),
    );
  const withoutPid = (matrix) =>
    Object.fromEntries(
      Object.entries(matrix).map(([key, value]) => [
        key,
        value && Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'pid')),
      ]),
    );
  const restored =
    known &&
    before?.components &&
    canonicalJson(withoutPid(components)) === canonicalJson(withoutPid(before.components));
  return {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    observedAt: new Date().toISOString(),
    components,
    state: !known
      ? 'unknown'
      : target
        ? 'target_runtime'
        : restored
          ? 'previous_runtime'
          : 'mixed_versions',
    runtimeConverged: Boolean(
      target && observed.api?.status === 'ok' && observed.acs?.status === 'ok' && publicWebPassed,
    ),
    recovery:
      'Runtime observation only; acceptance requires the final GitHub deployment success after cleanup. A failed attempt requires successful redeployment.',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , dir, mode] = process.argv;
  async function json(name) {
    try {
      return JSON.parse(await readFile(`${dir}/${name}.json`, 'utf8'));
    } catch {
      return null;
    }
  }
  const manifest = await json('manifest');
  const report = summarizeStagingState({
    manifest,
    before: await json('staging-before'),
    observed: {
      api: await json('staging-api-probe'),
      host: await json('staging-host-probe'),
      web: await json('staging-web-probe'),
      acs: await json('staging-acs-probe'),
    },
    publicWebPassed: mode === 'final' && (await json('staging-public-web'))?.status === 'passed',
  });
  await writeFile(`${dir}/staging-${mode}.json`, JSON.stringify(report, null, 2) + '\n');
  if (mode === 'final' && !report.runtimeConverged) process.exitCode = 1;
}

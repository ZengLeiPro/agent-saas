import { readFile } from 'node:fs/promises';
import { DIGEST_PATTERN } from './artifact-lib.mjs';

export function writerUpgradeRequired(capability, expected, status) {
  if (!DIGEST_PATTERN.test(expected?.implementationDigest ?? ''))
    throw new Error('Invalid expected Writer implementation digest');
  if (status === 401 || status === 403)
    throw new Error('Writer authentication failed; refusing an unverified upgrade');
  if (status !== 200) return true; // Trusted source + pinned SSH can recover an unavailable control plane.
  if (capability?.schemaVersion !== 1 || capability.service !== 'agent-saas-release-evidence')
    throw new Error('Unrecognized Writer capability response');
  return (
    capability.implementationDigest !== expected.implementationDigest ||
    capability.currentReleaseEvidenceSchemaVersion !== expected.releaseEvidenceSchemaVersion ||
    capability.releaseEvidenceSchemaRevision < expected.releaseEvidenceSchemaRevision ||
    !capability.supportedReleaseEvidenceSchemaVersions?.includes(
      expected.releaseEvidenceSchemaVersion,
    )
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , capabilitiesPath, buildPath, statusText] = process.argv;
  const status = Number(statusText);
  const expected = JSON.parse(await readFile(buildPath, 'utf8'));
  const capabilities =
    status === 200 ? JSON.parse(await readFile(capabilitiesPath, 'utf8')) : undefined;
  process.stdout.write(`${writerUpgradeRequired(capabilities, expected, status)}\n`);
}

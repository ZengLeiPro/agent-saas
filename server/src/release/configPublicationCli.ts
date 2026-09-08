import { preparePublicationAuthority, assertPublishedDisk } from '../../../scripts/release/config-publication.mjs';

const [command, configPath, releaseId, identityJson] = process.argv.slice(2);
if (command === 'prepare' && configPath && releaseId && identityJson) {
  const observed = JSON.parse(identityJson);
  // The identity CLI emits null for zero managed refs. Expected identities omit
  // that field, while observed summaries must retain the explicit null.
  const expected = {
    schemaVersion: observed.schemaVersion,
    digest: observed.digest,
    ...(observed.credentialVersionDigest == null ? {} : { credentialVersionDigest: observed.credentialVersionDigest }),
  };
  preparePublicationAuthority(configPath, releaseId, expected);
} else if (command === 'verify' && configPath) {
  const state = assertPublishedDisk(configPath);
  if (state && state.phase !== 'committed') throw new Error('Recover pending configuration transaction before deployment');
} else {
  throw new Error('Usage: config-publication-cli.js prepare <config> <release-id> <identity-json> | verify <config>');
}

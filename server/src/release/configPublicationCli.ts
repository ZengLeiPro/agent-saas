import { preparePublicationAuthority, assertPublishedDisk } from '../../../scripts/release/config-publication.mjs';

const [command, configPath, releaseId, identityJson] = process.argv.slice(2);
if (command === 'prepare' && configPath && releaseId && identityJson) {
  preparePublicationAuthority(configPath, releaseId, JSON.parse(identityJson));
} else if (command === 'verify' && configPath) {
  const state = assertPublishedDisk(configPath);
  if (state && state.phase !== 'committed') throw new Error('Recover pending configuration transaction before deployment');
} else {
  throw new Error('Usage: config-publication-cli.js prepare <config> <release-id> <identity-json> | verify <config>');
}

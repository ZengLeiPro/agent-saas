import { canonicalJson } from '@agent/shared/schemas/releaseManifest';
import { ReleaseAttestationStore } from '../src/release/releaseAttestationStore.js';
import type { ReleaseState } from '../src/release/releaseAttestation.js';

function usage(): never {
  throw new Error(
    'Usage: release-attestation.mts <status|append> <release-id> <manifest-digest> [state operation-key actor reason]',
  );
}

const [command, releaseId, manifestDigest, state, operationKey, actor, ...reasonParts] =
  process.argv.slice(2);
if (!command || !releaseId || !manifestDigest) usage();
const root = process.env.AGENT_SAAS_RELEASE_ATTESTATION_DIR;
if (!root) throw new Error('AGENT_SAAS_RELEASE_ATTESTATION_DIR is required');
const store = new ReleaseAttestationStore(root);

if (command === 'status') {
  const log = await store.read(releaseId, manifestDigest);
  process.stdout.write(
    `${canonicalJson({
      releaseId,
      manifestDigest,
      state: log.currentState(),
      promotable: log.isPromotable(),
      attestations: log.list(),
    })}\n`,
  );
} else if (command === 'append') {
  if (!state || !operationKey || !actor) usage();
  const entry = await store.append(releaseId, manifestDigest, {
    state: state as ReleaseState,
    operationKey,
    actor,
    manifestDigest,
    ...(reasonParts.length > 0 ? { reason: reasonParts.join(' ') } : {}),
  });
  process.stdout.write(`${canonicalJson(entry)}\n`);
} else {
  usage();
}

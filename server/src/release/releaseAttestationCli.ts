import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ReleaseAttestationStore } from './releaseAttestationStore.js';
import { RELEASE_STATES, type ReleaseState } from './releaseAttestation.js';

function parse(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

const args = parse(process.argv.slice(2));
if (
  !args.root ||
  !args['release-id'] ||
  !args.digest ||
  !args.state ||
  !args.operation ||
  !args.actor
)
  throw new Error(
    'usage: releaseAttestationCli.ts --root <dir> --release-id <id> --digest <digest> --state <state> --operation <key> --actor <actor> [--reason <text>] [--confirmation-evidence <json>]',
  );
if (!RELEASE_STATES.includes(args.state as ReleaseState)) throw new Error('Unknown release state');
const store = new ReleaseAttestationStore(args.root);
const currentState =
  args.state === 'completed'
    ? (await store.read(args['release-id'], args.digest)).currentState()
    : null;
if (args.state === 'completed' && currentState === 'awaiting_expand_confirmation') {
  if (!args['confirmation-evidence'])
    throw new Error('Expand completion requires --confirmation-evidence');
  const evidenceBytes = await readFile(args['confirmation-evidence']);
  const evidenceDigest = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
  let reason: Record<string, unknown>;
  try {
    reason = JSON.parse(args.reason ?? '') as Record<string, unknown>;
  } catch {
    throw new Error('Expand completion reason must be JSON evidence');
  }
  if (reason.confirmationEvidenceDigest !== evidenceDigest)
    throw new Error('Expand completion reason does not bind the confirmation evidence bytes');
}
const entry = await store.append(args['release-id'], args.digest, {
  state: args.state as ReleaseState,
  manifestDigest: args.digest,
  operationKey: args.operation,
  actor: args.actor,
  ...(args.reason ? { reason: args.reason } : {}),
});
process.stdout.write(`${JSON.stringify(entry)}\n`);

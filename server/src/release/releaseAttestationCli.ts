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
    'usage: releaseAttestationCli.ts --root <dir> --release-id <id> --digest <digest> --state <state> --operation <key> --actor <actor> [--reason <text>]',
  );
if (!RELEASE_STATES.includes(args.state as ReleaseState)) throw new Error('Unknown release state');
const store = new ReleaseAttestationStore(args.root);
const entry = await store.append(args['release-id'], args.digest, {
  state: args.state as ReleaseState,
  manifestDigest: args.digest,
  operationKey: args.operation,
  actor: args.actor,
  ...(args.reason ? { reason: args.reason } : {}),
});
process.stdout.write(`${JSON.stringify(entry)}\n`);

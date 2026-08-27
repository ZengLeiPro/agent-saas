import { readFile, writeFile } from 'node:fs/promises';
import { createReleaseCandidate, type ReleaseCandidateEvidence } from './createReleaseCandidate.js';

function args(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Expected --input and --output');
    output[key.slice(2)] = value;
  }
  return output;
}

const options = args(process.argv.slice(2));
if (!options.input || !options.output)
  throw new Error(
    'usage: createReleaseCandidateCli.ts --input <evidence.json> --output <manifest.json>',
  );
const evidence = JSON.parse(await readFile(options.input, 'utf8')) as ReleaseCandidateEvidence;
const manifest = createReleaseCandidate(evidence);
await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${manifest.releaseId} ${manifest.digest}\n`);

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPublicKeys } from '../../scripts/mobile-release-evidence.mjs';
import { validateRcEvidence } from './rc-contract.mjs';

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`invalid argument near ${argv[i] ?? '<end>'}`);
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
async function main() {
  const input = args(process.argv.slice(2));
  if (!input.plan || !input.bundle) throw new Error('--plan and --bundle are required; production also requires --evidenceRoot, --resultsRoot and --publicKeys');
  const plan = JSON.parse(await readFile(path.resolve(input.plan), 'utf8'));
  const bundle = JSON.parse(await readFile(path.resolve(input.bundle), 'utf8'));
  const production = bundle.mode === 'production';
  const result = await validateRcEvidence(bundle, {
    plan,
    hmacKey: process.env.MOBILE_RC_EVIDENCE_HMAC_KEY,
    evidenceRoot: input.evidenceRoot,
    resultsRoot: input.resultsRoot,
    nativeHmacKey: process.env.MOBILE_E2E_RECEIPT_HMAC_KEY,
    telemetryHmacKey: process.env.MOBILE_TELEMETRY_EVIDENCE_HMAC_KEY,
    releasePublicKeys: production ? loadPublicKeys(path.resolve(input.publicKeys ?? '')) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
});

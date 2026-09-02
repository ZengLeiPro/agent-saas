#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { authorizeEmergencyCommand, evaluateStage, validatePolicy, validateProductionPrerequisiteDocuments, verifyStageReceipt } from './rollout-contract.mjs';
import { loadPublicKeys } from '../../scripts/mobile-release-evidence.mjs';

function parse(argv) { const result = {}; for (let index = 0; index < argv.length; index += 2) { if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument near ${argv[index] ?? '<end>'}`); result[argv[index].slice(2)] = argv[index + 1]; } return result; }
async function json(path, label) { if (!path) throw new Error(`--${label} required`); return JSON.parse(await readFile(path, 'utf8')); }
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parse(argv); const command = args.command ?? 'evaluate'; const key = env.MOBILE_ROLLOUT_GATE_HMAC_KEY;
  if (command === 'lint-policy') { const policy = await json(args.policy, 'policy'); return validatePolicy(policy, { production: args.mode === 'production' }); }
  if (command === 'verify-receipt') return verifyStageReceipt(await json(args.receipt, 'receipt'), { key });
  if (command === 'authorize-emergency') return authorizeEmergencyCommand({ receipt: await json(args.receipt, 'receipt'), command: args.emergency }, { key });
  const productionOptions = () => ({ evidenceRoot: args['evidence-root'], releasePublicKeys: loadPublicKeys(args['release-public-keys'] ?? ''), telemetryHmacKey: env.MOBILE_TELEMETRY_EVIDENCE_HMAC_KEY, rcHmacKey: env.MOBILE_RC_EVIDENCE_HMAC_KEY, nativeHmacKey: env.MOBILE_E2E_RECEIPT_HMAC_KEY });
  if (command === 'validate-prerequisites') return validateProductionPrerequisiteDocuments(await json(args.input, 'input'), productionOptions());
  if (command !== 'evaluate') throw new Error('unsupported command');
  const policy = await json(args.policy, 'policy'); const input = await json(args.input, 'input');
  if (input.mode === 'production') await validateProductionPrerequisiteDocuments(input, productionOptions());
  const ledgerDocument = args.ledger ? await json(args.ledger, 'ledger') : { approvals: [], nonces: [], snapshots: [], receipts: [] };
  for (const field of ['approvals', 'nonces', 'snapshots', 'receipts']) if (!Array.isArray(ledgerDocument[field])) throw new Error(`ledger.${field} must be array`);
  const replayLedger = Object.fromEntries(Object.entries(ledgerDocument).map(([field, values]) => [field, new Set(values)]));
  const receipt = evaluateStage(input, { policy, key, replayLedger }); if (!args.output) throw new Error('--output required'); await writeFile(args.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  if (args['ledger-output']) { ledgerDocument.approvals.push(input.approval.approvalId); ledgerDocument.nonces.push(input.approval.nonce, input.receiptNonce); ledgerDocument.snapshots.push(input.telemetrySnapshot.snapshotId, input.supportSnapshot.snapshotId); ledgerDocument.receipts.push(receipt.receiptDigest); for (const field of Object.keys(ledgerDocument)) ledgerDocument[field] = [...new Set(ledgerDocument[field])]; await writeFile(args['ledger-output'], `${JSON.stringify(ledgerDocument, null, 2)}\n`, { flag: 'wx' }); }
  return { valid: true, status: receipt.status, receiptDigest: receipt.receiptDigest };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

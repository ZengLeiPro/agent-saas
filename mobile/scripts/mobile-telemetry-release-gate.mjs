import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const METRICS = [
  'crashFreeSessions', 'anrRate', 'startupP50Ms', 'startupP95Ms', 'chatAckP95Ms',
  'firstTokenP95Ms', 'wsRecoveryP95Ms', 'syncOverflowRate',
];
const PENDING = 'pending_external_approval';

function fail(message) { throw new Error(`[M60-05] ${message}`); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} keys are invalid`);
}
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function providerContractDigest(contract) {
  return `sha256:${createHash('sha256').update(canonicalize(contract)).digest('hex')}`;
}
function validFact(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,255}$/.test(value) && value !== PENDING; }

export function validateProviderContract(contract, { production = true, release } = {}) {
  const rootKeys = ['schemaVersion', 'provider', 'retentionDays', 'samplingRate', 'rateLimitPerMinute', 'sloPolicy', ...(contract?.exampleOnly === true ? ['exampleOnly'] : [])];
  exactKeys(contract, rootKeys, 'contract');
  if (contract.schemaVersion !== 1) fail('contract schemaVersion must be 1');
  if (production && contract.exampleOnly === true) fail('test fixture cannot satisfy production');
  exactKeys(contract.provider, ['kind', 'owner', 'dashboardId', 'alertPolicyId', 'environment', 'release', 'dsnSecretReference'], 'provider');
  for (const key of ['kind', 'owner', 'dashboardId', 'alertPolicyId', 'release', 'dsnSecretReference']) {
    if (!validFact(contract.provider[key])) fail(`provider.${key} is missing or pending`);
  }
  if (production && contract.provider.environment !== 'production') fail('provider environment must be production');
  if (release && contract.provider.release !== release) fail('provider release does not match build release');
  if (!Number.isInteger(contract.retentionDays) || contract.retentionDays < 1 || contract.retentionDays > 365) fail('retentionDays must be externally approved');
  if (typeof contract.samplingRate !== 'number' || !Number.isFinite(contract.samplingRate) || contract.samplingRate < 0 || contract.samplingRate > 1) fail('samplingRate must be externally approved');
  if (!Number.isInteger(contract.rateLimitPerMinute) || contract.rateLimitPerMinute < 1) fail('rateLimitPerMinute must be externally approved');
  exactKeys(contract.sloPolicy, ['status', 'metrics'], 'sloPolicy');
  if (!validFact(contract.sloPolicy.status)) fail('SLO policy approval is missing');
  exactKeys(contract.sloPolicy.metrics, METRICS, 'sloPolicy.metrics');
  for (const metric of METRICS) {
    const policy = contract.sloPolicy.metrics[metric];
    exactKeys(policy, ['operator', 'threshold'], `sloPolicy.metrics.${metric}`);
    if (!['>=', '<='].includes(policy.operator) || typeof policy.threshold !== 'number' || !Number.isFinite(policy.threshold)) {
      fail(`SLO metric ${metric} is pending or invalid`);
    }
  }
  return contract;
}

export function signTestEventReceipt(receipt, key) {
  if (typeof key !== 'string' || key.length < 32) fail('external evidence HMAC key is missing');
  const unsigned = { ...receipt };
  delete unsigned.signature;
  return `hmac-sha256:${createHmac('sha256', key).update(canonicalize(unsigned)).digest('hex')}`;
}

export function validateTestEventReceipt(receipt, contract, { release, key }) {
  exactKeys(receipt, ['schemaVersion', 'release', 'environment', 'contractDigest', 'dashboardId', 'alertPolicyId', 'testEvent', 'signature'], 'receipt');
  if (receipt.schemaVersion !== 1 || receipt.release !== release || receipt.environment !== 'production') fail('receipt release/environment is invalid');
  if (receipt.contractDigest !== providerContractDigest(contract)) fail('receipt contract digest mismatch');
  if (receipt.dashboardId !== contract.provider.dashboardId || receipt.alertPolicyId !== contract.provider.alertPolicyId) fail('receipt dashboard/alert facts mismatch');
  exactKeys(receipt.testEvent, ['kind', 'providerReceiptId', 'observedAt'], 'receipt.testEvent');
  if (receipt.testEvent.kind !== 'session_start' || !validFact(receipt.testEvent.providerReceiptId)) fail('real test-event provider receipt is missing');
  if (!Number.isFinite(Date.parse(receipt.testEvent.observedAt))) fail('test-event observedAt is invalid');
  const expected = signTestEventReceipt(receipt, key).slice('hmac-sha256:'.length);
  const actual = typeof receipt.signature === 'string' && receipt.signature.startsWith('hmac-sha256:') ? receipt.signature.slice('hmac-sha256:'.length) : '';
  if (!/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) fail('test-event receipt signature is invalid');
  return receipt;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) options[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  return options;
}

export function runGate({ configPath, receiptPath, release, key, production = true }) {
  if (!configPath || !receiptPath || !/^[a-f0-9]{40}$/.test(release ?? '')) fail('config, receipt and full release SHA are required');
  const contract = validateProviderContract(JSON.parse(readFileSync(configPath, 'utf8')), { production, release });
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  validateTestEventReceipt(receipt, contract, { release, key });
  return { contractDigest: providerContractDigest(contract), providerReceiptId: receipt.testEvent.providerReceiptId };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = runGate({
      configPath: args.config,
      receiptPath: args.receipt,
      release: args.release,
      key: process.env.MOBILE_TELEMETRY_EVIDENCE_HMAC_KEY,
      production: args.environment !== 'test',
    });
    process.stdout.write(`M60-05 release telemetry gate passed contract=${result.contractDigest} receipt=${result.providerReceiptId}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

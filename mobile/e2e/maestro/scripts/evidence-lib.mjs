import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RECEIPT_SCHEMA_VERSION = '1.0.0';
export const REQUIRED_SLOTS = Object.freeze([
  'ios-minimum',
  'ios-latest',
  'android-flagship',
  'android-low-end-small',
]);

export const SLOT_RULES = Object.freeze({
  'ios-minimum': { platform: 'ios', osRole: 'minimum' },
  'ios-latest': { platform: 'ios', osRole: 'latest' },
  'android-flagship': { platform: 'android', deviceClass: 'flagship' },
  'android-low-end-small': { platform: 'android', deviceClass: 'low-end-small' },
});

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function receiptPayload(receipt) {
  const { integrity: _integrity, ...payload } = receipt;
  return payload;
}

export function sealReceipt(payload, hmacKey) {
  if (typeof hmacKey !== 'string' || hmacKey.length < 32) {
    throw new Error('MOBILE_E2E_RECEIPT_HMAC_KEY must contain at least 32 characters');
  }
  const canonical = stableStringify(payload);
  const payloadSha256 = sha256(canonical);
  const hmacSha256 = createHmac('sha256', hmacKey).update(canonical).digest('hex');
  return {
    ...payload,
    integrity: { algorithm: 'HMAC-SHA256', payloadSha256, hmacSha256 },
  };
}

export function verifyReceiptSeal(receipt, hmacKey) {
  if (receipt?.integrity?.algorithm !== 'HMAC-SHA256') throw new Error('receipt integrity algorithm is invalid');
  const canonical = stableStringify(receiptPayload(receipt));
  const payloadDigest = sha256(canonical);
  if (payloadDigest !== receipt.integrity.payloadSha256) throw new Error('receipt payload digest mismatch (tampered)');
  const expected = createHmac('sha256', hmacKey).update(canonical).digest();
  const actualHex = receipt.integrity.hmacSha256;
  if (!/^[a-f0-9]{64}$/.test(actualHex ?? '')) throw new Error('receipt HMAC is malformed');
  const actual = Buffer.from(actualHex, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('receipt HMAC mismatch (tampered)');
}

export function assertSlotContract(slot, platform, deviceClass, osRole) {
  const rule = SLOT_RULES[slot];
  if (!rule) throw new Error(`unsupported evidence slot: ${slot}`);
  if (rule.platform !== platform) throw new Error(`${slot} requires platform=${rule.platform}`);
  if (rule.deviceClass && rule.deviceClass !== deviceClass) throw new Error(`${slot} requires deviceClass=${rule.deviceClass}`);
  if (rule.osRole && rule.osRole !== osRole) throw new Error(`${slot} requires osRole=${rule.osRole}`);
}

export function assertPhysicalAttestation(attestation, contract) {
  if (!attestation || attestation.schemaVersion !== '1') throw new Error('provider real-device attestation is missing or unsupported');
  if (attestation.evidenceKind !== 'real-device-attestation') throw new Error('provider attestation kind is not real-device');
  if (attestation.platform !== contract.platform) throw new Error('provider attestation platform mismatch');
  if (attestation.physical !== true || attestation.virtual !== false || attestation.browser !== false) {
    throw new Error('simulator/emulator/browser evidence is forbidden');
  }
  for (const field of ['providerName', 'providerRunId', 'deviceIdentifierHash', 'issuedAt', 'buildSha', 'appId', 'version', 'signingFingerprint']) {
    if (typeof attestation[field] !== 'string' || !attestation[field].trim()) throw new Error(`provider attestation ${field} is required`);
  }
  if (attestation.buildSha !== contract.buildSha || attestation.appId !== contract.appId || attestation.version !== contract.version
    || attestation.signingFingerprint.toLowerCase() !== contract.signingFingerprint.toLowerCase()) {
    throw new Error('provider attestation signed-build identity mismatch');
  }
  const forbidden = `${attestation.providerName} ${attestation.deviceModel ?? ''} ${attestation.deviceClass ?? ''}`.toLowerCase();
  if (/simulator|emulator|browser|viewport|playwright|headless/.test(forbidden)) throw new Error('provider attestation identifies a non-physical target');
  if (!/^[a-f0-9]{64}$/.test(attestation.deviceIdentifierHash)) throw new Error('deviceIdentifierHash must be a SHA-256 digest');
}

export function redact(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"']+/gi, '<origin-redacted>')
    .replace(/((?:authorization|bearer|token|secret|password|otp|code)[\s"'=:\\]+)[^\s,"']+/gi, '$1<redacted>')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '<opaque-redacted>')
    .replace(/(?:\/workspace|\/home\/[^/\s]+|\/Users\/[^/\s]+)\/[^\s"']+/g, '<path-redacted>');
}

export async function writeImmutableJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'wx', 0o444);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o444);
}

export async function writeImmutableText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'wx', 0o444);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o444);
}

export async function hashFlowTree(root) {
  const entries = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else if (/\.(ya?ml|js|json)$/.test(name) && !full.includes(`${path.sep}tests${path.sep}`)) {
        entries.push(`${path.relative(root, full).replaceAll(path.sep, '/')}\0${await readFile(full, 'utf8')}`);
      }
    }
  }
  await walk(root);
  return sha256(entries.join('\0'));
}

export async function listFilesRecursive(root, extension) {
  const result = [];
  async function walk(dir) {
    let names;
    try { names = await readdir(dir); } catch { return; }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else if (!extension || name.endsWith(extension)) result.push(full);
    }
  }
  await walk(root);
  return result;
}

export async function boundedSanitizedLog(source, destination, maxBytes = 65536) {
  let data = '';
  try { data = await readFile(source, 'utf8'); } catch { data = 'Maestro produced no readable log.\n'; }
  const sanitized = redact(data);
  const bounded = Buffer.from(sanitized).subarray(-maxBytes).toString('utf8');
  await writeFile(destination, bounded, { encoding: 'utf8', mode: 0o600 });
  return { bytes: Buffer.byteLength(bounded), truncated: Buffer.byteLength(sanitized) > maxBytes };
}

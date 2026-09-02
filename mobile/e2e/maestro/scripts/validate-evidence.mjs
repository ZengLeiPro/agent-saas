#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_SLOTS,
  assertPhysicalAttestation,
  assertSlotContract,
  hashFlowTree,
  listFilesRecursive,
  sha256,
  verifyReceiptSeal,
} from './evidence-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const maestroRoot = path.resolve(scriptDir, '..');
const coverage = JSON.parse(await readFile(path.join(maestroRoot, 'coverage.json'), 'utf8'));
const expectedFlowIds = coverage.flows.map((flow) => flow.id).sort();
const expectedFlowHash = await hashFlowTree(maestroRoot);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument near ${argv[index] ?? '<end>'}`);
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function assertReceiptShape(receipt) {
  if (receipt?.schemaVersion !== '1.0.0') throw new Error('unsupported receipt schemaVersion');
  requiredString(receipt.receiptId, 'receiptId');
  if (!/^[a-f0-9]{64}$/.test(receipt.receiptId)) throw new Error('receiptId must be SHA-256');
  requiredString(receipt.flowHash, 'flowHash');
  if (!/^[a-f0-9]{64}$/.test(receipt.flowHash)) throw new Error('flowHash must be SHA-256');
  for (const key of ['platform', 'device', 'osVersion', 'osRole', 'deviceClass', 'buildSha', 'sourceHead', 'appId', 'version', 'signingFingerprint', 'testRunId', 'slot']) {
    requiredString(receipt.contract?.[key], `contract.${key}`);
  }
  if (!Array.isArray(receipt.flows) || receipt.flows.length === 0) throw new Error('receipt flows are required');
  if (!receipt.artifacts?.junit?.path || !receipt.artifacts?.screenshots?.path || !receipt.artifacts?.limitedLog?.path) throw new Error('receipt artifact manifest is incomplete');
}

async function verifyArtifacts(receiptPath, receipt) {
  const root = path.dirname(receiptPath);
  const resolveInside = (relative) => {
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('receipt artifact path escapes receipt directory');
    return resolved;
  };
  const junit = resolveInside(receipt.artifacts.junit.path);
  const screenshotList = resolveInside(receipt.artifacts.screenshots.path);
  const limitedLog = resolveInside(receipt.artifacts.limitedLog.path);
  for (const file of [junit, screenshotList, limitedLog]) {
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`receipt artifact is not a file: ${path.basename(file)}`);
  }
  if (sha256(await readFile(junit, 'utf8')) !== receipt.artifacts.junit.sha256) throw new Error('JUnit digest mismatch');
  const screenshots = JSON.parse(await readFile(screenshotList, 'utf8'));
  if (!Array.isArray(screenshots) || screenshots.length !== receipt.artifacts.screenshots.count) throw new Error('screenshot manifest count mismatch');
  for (const item of screenshots) {
    const file = resolveInside(item.path);
    const bytes = await readFile(file);
    if (sha256(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`screenshot digest mismatch: ${item.path}`);
  }
  const logText = await readFile(limitedLog, 'utf8');
  if (Buffer.byteLength(logText) > 65536) throw new Error('limited log exceeds 64 KiB');
  if (/authorization:\s*bearer\s+\S+|https?:\/\/[^\s<]+|password[=:]\s*[^<\s]+/i.test(logText)) throw new Error('limited log contains unredacted sensitive data');
}

export async function validateReceiptSet({ receiptPaths, expectedBuildSha, hmacKey, mode = 'real', verifyFiles = true }) {
  if (!Array.isArray(receiptPaths) || receiptPaths.length === 0) throw new Error('no receipts found');
  const receipts = [];
  for (const receiptPath of receiptPaths) {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assertReceiptShape(receipt);
    verifyReceiptSeal(receipt, hmacKey);
    if (verifyFiles) await verifyArtifacts(receiptPath, receipt);
    receipts.push({ receiptPath, receipt });
  }

  const expectedKind = mode === 'mock' ? 'deterministic-mock' : 'real-device';
  const bySlot = new Map();
  const replayFields = [new Set(), new Set(), new Set()];
  const first = receipts[0].receipt;
  for (const { receipt } of receipts) {
    if (receipt.evidenceKind !== expectedKind) throw new Error(`${receipt.contract.slot}: ${receipt.evidenceKind} cannot satisfy ${mode} evidence`);
    if (bySlot.has(receipt.contract.slot)) throw new Error(`duplicate/replay slot receipt: ${receipt.contract.slot}`);
    bySlot.set(receipt.contract.slot, receipt);
    assertSlotContract(receipt.contract.slot, receipt.contract.platform, receipt.contract.deviceClass, receipt.contract.osRole);
    if (mode === 'real') {
      assertPhysicalAttestation({
        schemaVersion: '1', evidenceKind: 'real-device-attestation', platform: receipt.contract.platform,
        physical: receipt.device?.physical, virtual: receipt.device?.virtual, browser: receipt.device?.browser,
        providerName: receipt.device?.providerName, providerRunId: receipt.device?.providerRunId,
        deviceIdentifierHash: receipt.device?.deviceIdentifierHash, issuedAt: receipt.run?.completedAt,
        buildSha: receipt.contract.buildSha, appId: receipt.contract.appId, version: receipt.contract.version,
        signingFingerprint: receipt.contract.signingFingerprint, deviceModel: receipt.device?.model,
      }, receipt.contract);
    }
    if (receipt.run?.status !== 'passed' || receipt.flows.some((flow) => flow.status !== 'passed')) throw new Error(`${receipt.contract.slot}: failed flow cannot satisfy release evidence`);
    const actualFlowIds = receipt.flows.map((flow) => flow.id).sort();
    if (new Set(actualFlowIds).size !== actualFlowIds.length || JSON.stringify(actualFlowIds) !== JSON.stringify(expectedFlowIds)) {
      throw new Error(`${receipt.contract.slot}: receipt flow coverage is incomplete or duplicated`);
    }
    if (receipt.contract.buildSha !== expectedBuildSha || receipt.contract.sourceHead !== expectedBuildSha) throw new Error(`${receipt.contract.slot}: cross-SHA/same-build receipt rejected`);
    if (receipt.contract.version !== first.contract.version) throw new Error('receipts do not share one app version/build');
    if (receipt.flowHash !== expectedFlowHash) throw new Error(`${receipt.contract.slot}: stale or foreign flow hash rejected`);
    if (receipt.flowHash !== first.flowHash) throw new Error('receipts do not share one immutable flow hash');
    const replayValues = [receipt.receiptId, receipt.contract.testRunId, receipt.device?.providerRunId ?? receipt.receiptId];
    replayValues.forEach((value, index) => {
      if (replayFields[index].has(value)) throw new Error(`replayed receipt identity rejected: ${value}`);
      replayFields[index].add(value);
    });
  }

  const missing = REQUIRED_SLOTS.filter((slot) => !bySlot.has(slot));
  const extra = [...bySlot.keys()].filter((slot) => !REQUIRED_SLOTS.includes(slot));
  if (missing.length || extra.length || receipts.length !== REQUIRED_SLOTS.length) {
    throw new Error(`four-slot evidence incomplete; missing=[${missing.join(',')}], extra=[${extra.join(',')}]`);
  }
  return { buildSha: expectedBuildSha, version: first.contract.version, flowHash: first.flowHash, slots: REQUIRED_SLOTS };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const receiptsDir = path.resolve(requiredString(args.receipts, '--receipts'));
  const expectedBuildSha = requiredString(args.buildSha, '--buildSha');
  const mode = args.mode ?? 'real';
  if (!['real', 'mock'].includes(mode)) throw new Error('--mode must be real or mock');
  if (!/^[a-f0-9]{40}$/.test(expectedBuildSha)) throw new Error('--buildSha must be a full lowercase Git SHA');
  const hmacKey = requiredString(process.env.MOBILE_E2E_RECEIPT_HMAC_KEY, 'MOBILE_E2E_RECEIPT_HMAC_KEY');
  const receiptPaths = (await listFilesRecursive(receiptsDir, 'receipt.json')).sort();
  const result = await validateReceiptSet({ receiptPaths, expectedBuildSha, hmacKey, mode, verifyFiles: true });
  process.stdout.write(`${JSON.stringify({ valid: true, mode, ...result })}\n`);
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`evidence validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

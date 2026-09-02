#!/usr/bin/env node
import process from 'node:process';
import { REQUIRED_SLOTS, assertSlotContract } from './evidence-lib.mjs';

export function validateDeviceMatrix(matrix) {
  if (!Array.isArray(matrix)) throw new Error('device matrix must be a JSON array');
  if (matrix.length !== REQUIRED_SLOTS.length) throw new Error(`device matrix must contain exactly ${REQUIRED_SLOTS.length} slots`);
  const seen = new Set();
  for (const entry of matrix) {
    if (!entry || typeof entry !== 'object') throw new Error('matrix entry must be an object');
    for (const field of ['slot', 'platform', 'device', 'osVersion', 'osRole', 'deviceClass', 'appId', 'version', 'signingFingerprint', 'providerExecutable', 'executionTarget']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new Error(`${entry.slot ?? '<unknown>'}.${field} is required`);
    }
    if (seen.has(entry.slot)) throw new Error(`duplicate matrix slot: ${entry.slot}`);
    seen.add(entry.slot);
    assertSlotContract(entry.slot, entry.platform, entry.deviceClass, entry.osRole);
    if (!['self-hosted', 'device-farm'].includes(entry.executionTarget)) throw new Error(`${entry.slot}.executionTarget must be self-hosted or device-farm`);
    if (!Array.isArray(entry.runnerLabels) || entry.runnerLabels.length === 0 || entry.runnerLabels.some((label) => typeof label !== 'string' || !label.trim())) {
      throw new Error(`${entry.slot}.runnerLabels must be an explicitly configured non-empty string array`);
    }
    if (entry.executionTarget === 'self-hosted' && !entry.runnerLabels.includes('self-hosted')) {
      throw new Error(`${entry.slot}: self-hosted target must include the self-hosted runner label`);
    }
    if (!/^[A-Fa-f0-9:]{32,}$/.test(entry.signingFingerprint)) throw new Error(`${entry.slot}.signingFingerprint is not a certificate digest`);
    if (!/^\//.test(entry.providerExecutable) || /[\s;&|`$]/.test(entry.providerExecutable)) {
      throw new Error(`${entry.slot}.providerExecutable must be an absolute executable path without shell syntax`);
    }
  }
  const missing = REQUIRED_SLOTS.filter((slot) => !seen.has(slot));
  if (missing.length) throw new Error(`device matrix missing slots: ${missing.join(', ')}`);
  return matrix;
}

if (process.argv[1]?.endsWith('validate-device-matrix.mjs')) {
  try {
    const raw = process.env.MOBILE_E2E_MATRIX_JSON;
    if (!raw) throw new Error('MOBILE_E2E_MATRIX_JSON is required');
    const matrix = validateDeviceMatrix(JSON.parse(raw));
    process.stdout.write(`${JSON.stringify({ valid: true, slots: matrix.map((entry) => entry.slot) })}\n`);
  } catch (error) {
    process.stderr.write(`device matrix rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs';

const [healthPath, rollbackEnvPath, candidateEnvPath] = process.argv.slice(2);
if (!healthPath || !rollbackEnvPath || !candidateEnvPath) {
  console.error('usage: check-acs-shared-rollback-compatibility.mjs <health.json> <rollback.env> <candidate.env>');
  process.exit(2);
}

function parseEnv(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function envSnatConfig(path) {
  const env = parseEnv(path);
  const sharedCidrs = (env.ACS_SNAT_SHARED_CIDRS || env.ACS_SNAT_SHARED_CIDR || '')
    .split(',').map((value) => value.trim()).filter(Boolean).sort();
  return {
    mode: env.ACS_SNAT_MODE,
    regionId: env.ACS_SNAT_REGION_ID,
    snatTableId: env.ACS_SNAT_TABLE_ID,
    snatIp: env.ACS_SNAT_IP,
    sharedCidrs,
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const health = JSON.parse(readFileSync(healthPath, 'utf8'));
const rollback = envSnatConfig(rollbackEnvPath);
const candidate = envSnatConfig(candidateEnvPath);
const snat = health?.snat ?? {};
const running = {
  mode: snat.mode,
  regionId: snat.regionId,
  snatTableId: snat.snatTableId,
  snatIp: snat.snatIp,
  sharedCidrs: Array.isArray(snat.sharedCidrs) ? [...snat.sharedCidrs].sort() : [],
};
const reasons = [];
if (rollback.mode !== 'shared-cidr' || candidate.mode !== 'shared-cidr' || running.mode !== 'shared-cidr') {
  reasons.push('SNAT mode is not shared-cidr');
}
if (!rollback.regionId || !rollback.snatTableId || !rollback.snatIp || rollback.sharedCidrs.length === 0) {
  reasons.push('rollback shared SNAT config is incomplete');
}
if (!same(rollback, candidate)) reasons.push('candidate shared SNAT config differs from rollback config');
if (!same(rollback, running)) reasons.push('running shared SNAT config differs from rollback config');
if (health?.status !== 'ok' || health?.checks?.snat !== 'ok') reasons.push('running ACS health is not ok');
if (snat.sharedCidrAvailableCount !== rollback.sharedCidrs.length) reasons.push('not all rollback shared CIDRs are Available');
if (!Array.isArray(snat.uncoveredPodCidrs) || snat.uncoveredPodCidrs.length !== 0) reasons.push('running Pod CIDRs are not fully covered');
if (snat.unexpectedCount !== 0) reasons.push('unexpected SNAT entries are present');
if (typeof snat.sharedCidrConfigDigest !== 'string' || !snat.sharedCidrConfigDigest) reasons.push('shared CIDR digest is unavailable');

if (reasons.length) {
  writeSync(2, `${JSON.stringify({ compatible: false, reasons })}\n`);
  process.exit(1);
}
console.log(JSON.stringify({
  compatible: true,
  sharedCidrConfigDigest: snat.sharedCidrConfigDigest,
  sharedCidrCount: rollback.sharedCidrs.length,
}));

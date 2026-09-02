#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestValue, sealBundle, validatePlan } from './rc-contract.mjs';

function args(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) out[argv[i]?.replace(/^--/, '')] = argv[i + 1]; return out; }
async function findResults(root) {
  const results = [];
  async function walk(dir) {
    for (const name of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) await walk(full);
      else if (name.name === 'result.json') {
        const result = JSON.parse(await readFile(full, 'utf8'));
        result.evidenceBase = path.relative(root, path.dirname(full)).replaceAll(path.sep, '/');
        results.push(result);
      }
    }
  }
  await walk(root); return results;
}
async function main() {
  const input = args(process.argv.slice(2));
  for (const key of ['plan', 'results', 'm60', 'commitSha', 'profile', 'output']) if (!input[key]) throw new Error(`--${key} is required`);
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new Error('--commitSha must be a full Git SHA');
  const plan = JSON.parse(await readFile(path.resolve(input.plan), 'utf8')); const planInfo = validatePlan(plan);
  const m60 = JSON.parse(await readFile(path.resolve(input.m60), 'utf8')); const caseResults = await findResults(path.resolve(input.results));
  const statuses = Object.fromEntries(['pass', 'fail', 'blocked', 'skipped'].map((status) => [status, caseResults.filter((item) => item.status === status).length]));
  const open = (severity) => caseResults.flatMap((item) => item.defects ?? []).filter((item) => item.severity === severity && item.status === 'open').length;
  const hours = Number(input.expiryHours ?? 24); if (!Number.isFinite(hours) || hours <= 0 || hours > 72) throw new Error('--expiryHours must be in (0,72]');
  const mode = input.mode ?? 'production';
  const payload = {
    schemaVersion: '1.0.0', mode, explicitContractMock: mode === 'contract', planId: plan.planId,
    planDigest: planInfo.planDigest, commitSha: input.commitSha, profile: input.profile,
    expiresAt: new Date(Date.now() + hours * 3600000).toISOString(), m60, caseResults,
    summary: { ...statuses, openP0: open('P0'), openP1: open('P1') },
  };
  const bundle = sealBundle(payload, process.env.MOBILE_RC_EVIDENCE_HMAC_KEY);
  await writeFile(path.resolve(input.output), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o444, flag: 'wx' });
  process.stdout.write(`M70-01 bundle assembled cases=${caseResults.length} digest=${digestValue(bundle)}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

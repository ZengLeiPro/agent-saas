#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestValue, HARD_STOPS, validatePlan } from './rc-contract.mjs';

function fail(message) { throw new Error(`[M70-01 runner] ${message}`); }
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) fail(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2); const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`--${key} requires a value`);
    result[key] = value; i += 1;
  }
  return result;
}
function required(value, label) { if (typeof value !== 'string' || !value) fail(`${label} is required`); return value; }
function run(executable, requestPath, outputPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--request', requestPath, '--output', outputPath], {
      cwd, shell: false, stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`provider exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)));
  });
}
function inside(root, relative, label) {
  if (typeof relative !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]+$/.test(relative)) fail(`${label} path is invalid`);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) fail(`${label} escapes output directory`);
  return resolved;
}
async function fileEvidence(root, relative, label, maximum = 10 * 1024 * 1024) {
  const file = inside(root, relative, label); const bytes = await readFile(file);
  if (bytes.length === 0 || bytes.length > maximum) fail(`${label} size is invalid`);
  return { path: relative.replaceAll(path.sep, '/'), digest: digestValue(bytes) };
}

export async function runCase(input) {
  const plan = JSON.parse(await readFile(path.resolve(input.plan), 'utf8'));
  validatePlan(plan);
  const item = plan.cases.find((candidate) => candidate.id === input.caseId);
  if (!item) fail(`unknown case ${input.caseId}`);
  if (!/^[0-9a-f]{40}$/.test(input.buildSha ?? '')) fail('buildSha must be a full Git SHA');
  required(input.buildId, 'buildId');
  if (!/^sha256:[0-9a-f]{64}$/.test(input.artifactDigest ?? '')) fail('artifactDigest is invalid');
  if (!/^[0-9a-f]{64}$/.test(input.m60ReceiptId ?? '')) fail('m60ReceiptId is invalid');
  const mode = input.mode ?? 'production';
  if (!['production', 'contract'].includes(mode)) fail('mode must be production or contract');
  if (mode === 'production' && input.fixture) fail('fixture input cannot satisfy production');
  if (mode === 'production' && !input.providerExecutable) fail('an explicit configured provider executable is required');
  if (mode === 'contract' && !input.fixture) fail('contract mode requires an explicit mock fixture');
  const outputDir = path.resolve(required(input.outputDir, 'outputDir'));
  await mkdir(outputDir, { recursive: true });
  const providerOutput = path.join(outputDir, 'provider-receipt.json');
  const request = {
    schemaVersion: '1.0.0', case: item, buildSha: input.buildSha, profile: input.profile,
    artifactDigest: input.artifactDigest, fixtureServerOrigin: process.env.MOBILE_RC_FIXTURE_SERVER_ORIGIN ? '<configured>' : null,
  };
  const requestPath = path.join(outputDir, 'provider-request.json');
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  if (mode === 'production') await run(path.resolve(input.providerExecutable), requestPath, providerOutput, outputDir);
  else await writeFile(providerOutput, await readFile(path.resolve(input.fixture)), { mode: 0o600, flag: 'wx' });
  const rawBytes = await readFile(providerOutput);
  if (rawBytes.length === 0 || rawBytes.length > 65536 || /(?:authorization|bearer|password|secret|token)["'=:\\s]+[^<"'\\s]+/i.test(rawBytes.toString('utf8'))) fail('provider receipt is unbounded or contains credentials');
  const raw = JSON.parse(rawBytes.toString('utf8'));
  if (raw.schemaVersion !== '1.0.0' || raw.caseId !== item.id) fail('provider receipt case/schema mismatch');
  if (raw.evidenceKind !== (mode === 'production' ? 'real-device' : 'mock')) fail('provider real/native/simulator/mock label is invalid for mode');
  if (mode === 'production' && (raw.device?.physical !== true || raw.device?.virtual !== false || raw.device?.simulator !== false)) fail('production RC requires a physical device attestation');
  if (raw.device?.slot !== item.platformSlot) fail('provider slot does not match plan');
  if (!['pass', 'fail', 'blocked', 'skipped'].includes(raw.status)) fail('provider status is invalid');
  if (!Array.isArray(raw.assertions)) fail('provider assertions are missing');
  const evidenceDir = path.join(outputDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const screenshots = [];
  for (const [index, relative] of (raw.screenshotPaths ?? []).entries()) {
    const source = inside(outputDir, relative, `screenshot[${index}]`);
    const extension = path.extname(relative).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) fail(`screenshot[${index}] format is unsupported`);
    const normalized = `evidence/screenshot-${String(index + 1).padStart(2, '0')}${extension}`;
    await copyFile(source, path.join(outputDir, normalized), 0);
    screenshots.push(await fileEvidence(outputDir, normalized, `screenshot[${index}]`));
  }
  if (screenshots.length === 0) fail('at least one screenshot is required');
  const sourceLog = inside(outputDir, raw.logPath, 'limited log');
  const logText = await readFile(sourceLog, 'utf8');
  await copyFile(sourceLog, path.join(evidenceDir, 'limited.log'), 0);
  const log = await fileEvidence(outputDir, 'evidence/limited.log', 'limited log', 65536);
  if (/authorization:\s*bearer\s+\S+|https?:\/\/[^\s<]+|password[=:]\s*[^<\s]+|(?:token|secret)[=:]\s*[^<\s]+/i.test(logText)) fail('limited log contains unredacted evidence');
  if (!raw.hardStops || Object.keys(raw.hardStops).sort().join() !== [...HARD_STOPS].sort().join()) fail('provider hard-stop counters are incomplete');
  if (!Array.isArray(raw.priorFailureReceiptIds ?? [])) fail('provider prior failure ledger is invalid');
  const result = {
    caseId: item.id,
    testRunId: required(input.testRunId, 'testRunId'),
    attempt: Number(input.attempt ?? 1),
    priorFailureReceiptIds: raw.priorFailureReceiptIds ?? [],
    flowHash: raw.flowHash,
    status: raw.status,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    evidenceKind: raw.evidenceKind,
    explicitContractMock: mode === 'contract',
    source: { commitSha: input.buildSha, buildId: input.buildId, profile: input.profile, artifactDigest: input.artifactDigest },
    deviceReceipt: {
      slot: item.platformSlot,
      receiptId: raw.providerReceiptId,
      digest: digestValue(rawBytes),
      path: 'provider-receipt.json',
      m60ReceiptId: input.m60ReceiptId,
    },
    assertions: raw.assertions,
    screenshots,
    log,
    defects: raw.defects ?? [],
    hardStops: raw.hardStops,
    ...(raw.retryOf ? { retryOf: raw.retryOf } : {}),
  };
  await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o444, flag: 'wx' });
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCase(args(process.argv.slice(2))).then((result) => process.stdout.write(`M70-01 case ${result.caseId} recorded status=${result.status}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
  });
}

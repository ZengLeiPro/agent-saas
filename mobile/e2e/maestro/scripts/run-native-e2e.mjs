#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  RECEIPT_SCHEMA_VERSION,
  assertPhysicalAttestation,
  assertSlotContract,
  boundedSanitizedLog,
  hashFlowTree,
  listFilesRecursive,
  redact,
  sealReceipt,
  sha256,
  writeImmutableJson,
  writeImmutableText,
} from './evidence-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(root, '../../..');
const coverage = JSON.parse(await readFile(path.join(root, 'coverage.json'), 'utf8'));

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`);
    values[key.slice(2)] = argv[index + 1];
  }
  return values;
}

function requireValue(values, key) {
  const value = values[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

function requireSecret(name, minimum = 1) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length < minimum) throw new Error(`${name} is required; native E2E fails closed`);
  return value;
}

function parseSecretJson(name, requiredKeys) {
  let parsed;
  try { parsed = JSON.parse(requireSecret(name)); } catch { throw new Error(`${name} must be valid JSON`); }
  for (const key of requiredKeys) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`${name}.${key} is required`);
  }
  return parsed;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function fixtureCall(origin, token, action, body) {
  const endpoint = new URL(`/native-e2e/${action}`, origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) throw new Error(`fixture server ${action} rejected scenario`);
    return { fixtureVersion: String(result.fixtureVersion ?? 'unknown') };
  } finally {
    clearTimeout(timeout);
  }
}

function providerContext(contract, outputDir, flowId) {
  return {
    schemaVersion: '1',
    contract,
    flowId,
    paths: {
      outputDir,
      attestation: path.join(outputDir, 'provider-attestation.json'),
      currentApp: process.env.MOBILE_E2E_APP_PATH ?? null,
      oldApp: process.env.MOBILE_E2E_OLD_APP_PATH ?? null,
      pickerFixture: process.env.MOBILE_E2E_PICKER_FIXTURE_PATH ?? null,
    },
  };
}

async function callProvider(executable, phase, context, outputDir) {
  const contextPath = path.join(outputDir, `provider-${phase}-${context.flowId ?? 'run'}.json`);
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  const result = await run(executable, [phase, contextPath], { cwd: repoRoot });
  if (result.code !== 0) throw new Error(`device provider phase ${phase} failed with exit ${result.code}`);
}

function maestroEnvironment(accounts, artifacts, otp, serviceOrigin, screenshotDir) {
  return {
    E2E_ACCOUNT_A_USERNAME: accounts.accountAUsername,
    E2E_ACCOUNT_A_PASSWORD: accounts.accountAPassword,
    E2E_ACCOUNT_B_USERNAME: accounts.accountBUsername,
    E2E_ACCOUNT_B_PASSWORD: accounts.accountBPassword,
    E2E_ACCOUNT_A_PHONE: accounts.accountAPhone,
    E2E_OTP: otp,
    E2E_SERVICE_ORIGIN: serviceOrigin,
    E2E_ARTIFACT_IMAGE_NAME: artifacts.imageName,
    E2E_ARTIFACT_PDF_NAME: artifacts.pdfName,
    E2E_ARTIFACT_HTML_NAME: artifacts.htmlName,
    E2E_PICKER_FILE_NAME: artifacts.pickerFileName,
    E2E_SHARE_FILE_NAME: artifacts.shareFileName,
    E2E_ATTACHMENT_ID: artifacts.attachmentId,
    E2E_SCREENSHOT_DIR: screenshotDir,
  };
}

function toMaestroEnvArgs(environment) {
  return Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

async function mergeJunit(flowResults, outputPath) {
  const cases = flowResults.map((flow) => {
    const failure = flow.status === 'passed' ? '' : `<failure message="${xmlEscape(flow.error ?? 'flow failed')}"/>`;
    return `<testcase classname="mobile.native.maestro" name="${xmlEscape(flow.id)}" time="${(flow.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
  }).join('');
  const failures = flowResults.filter((flow) => flow.status !== 'passed').length;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="M60-02 native E2E" tests="${flowResults.length}" failures="${failures}">${cases}</testsuite>\n`;
  await writeImmutableText(outputPath, xml);
}

let args;
let outputDir;
let rawLog;
let logStream;
let logClosed = false;
let failure;
try {
  args = parseArgs(process.argv.slice(2));
  const platform = requireValue(args, 'platform');
  const device = requireValue(args, 'device');
  const osVersion = requireValue(args, 'osVersion');
  const osRole = requireValue(args, 'osRole');
  const deviceClass = requireValue(args, 'deviceClass');
  const buildSha = requireValue(args, 'buildSha');
  const appId = requireValue(args, 'appId');
  const version = requireValue(args, 'version');
  const signingFingerprint = requireValue(args, 'signingFingerprint');
  const testRunId = requireValue(args, 'testRunId');
  const slot = requireValue(args, 'slot');
  const providerExecutable = requireValue(args, 'providerExecutable');
  outputDir = path.resolve(requireValue(args, 'outputDir'));

  if (!['ios', 'android'].includes(platform)) throw new Error('--platform must be ios or android');
  if (!/^[a-f0-9]{40}$/.test(buildSha)) throw new Error('--buildSha must be a full lowercase Git SHA');
  if (!/^[A-Za-z0-9._:-]+$/.test(testRunId)) throw new Error('--testRunId contains unsafe characters');
  if (!/^[A-Fa-f0-9:]{32,}$/.test(signingFingerprint)) throw new Error('--signingFingerprint must be a certificate digest');
  assertSlotContract(slot, platform, deviceClass, osRole);

  const { stdout: headStdout } = await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout }) : reject(new Error('unable to resolve repository HEAD')));
  });
  const sourceHead = headStdout.trim();
  if (sourceHead !== buildSha) throw new Error(`cross-SHA execution rejected: HEAD ${sourceHead} != build ${buildSha}`);

  const accounts = parseSecretJson('MOBILE_E2E_ACCOUNTS_JSON', [
    'accountAUsername', 'accountAPassword', 'accountBUsername', 'accountBPassword', 'accountAPhone',
  ]);
  const artifacts = parseSecretJson('MOBILE_E2E_ARTIFACTS_JSON', [
    'imageName', 'pdfName', 'htmlName', 'pickerFileName', 'shareFileName', 'attachmentId',
  ]);
  const otp = requireSecret('MOBILE_E2E_OTP');
  const serviceOrigin = requireSecret('MOBILE_E2E_SERVICE_ORIGIN');
  const fixtureOrigin = requireSecret('MOBILE_E2E_FIXTURE_SERVER_ORIGIN');
  const fixtureToken = requireSecret('MOBILE_E2E_FIXTURE_TOKEN', 16);
  const hmacKey = requireSecret('MOBILE_E2E_RECEIPT_HMAC_KEY', 32);
  for (const [name, origin] of [['service origin', serviceOrigin], ['fixture origin', fixtureOrigin]]) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  }

  await mkdir(path.dirname(outputDir), { recursive: true });
  await mkdir(outputDir, { recursive: false });
  const screenshotDir = path.join(outputDir, 'screenshots');
  const junitPartsDir = path.join(outputDir, 'junit-parts');
  await mkdir(screenshotDir);
  await mkdir(junitPartsDir, { recursive: false });
  rawLog = path.join(outputDir, 'maestro.raw.log');
  logStream = createWriteStream(rawLog, { flags: 'wx', mode: 0o600 });
  const flowHash = await hashFlowTree(root);
  const contract = {
    platform, device, osVersion, osRole, deviceClass, buildSha, sourceHead, appId, version,
    signingFingerprint: signingFingerprint.toLowerCase(), testRunId, slot,
  };
  await writeFile(path.join(outputDir, 'contract.json'), `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });

  await callProvider(providerExecutable, 'prepare-run', providerContext(contract, outputDir, null), outputDir);
  const attestation = JSON.parse(await readFile(path.join(outputDir, 'provider-attestation.json'), 'utf8'));
  assertPhysicalAttestation(attestation, contract);

  const env = maestroEnvironment(accounts, artifacts, otp, serviceOrigin, screenshotDir);
  const flowResults = [];
  let fixtureVersion = null;
  for (const flow of coverage.flows) {
    const started = Date.now();
    let status = 'passed';
    let error = null;
    const context = providerContext(contract, outputDir, flow.id);
    try {
      await callProvider(providerExecutable, 'prepare-flow', context, outputDir);
      const fixture = await fixtureCall(fixtureOrigin, fixtureToken, 'reset', { scenario: flow.fixture, testRunId, buildSha, slot });
      fixtureVersion = fixture.fixtureVersion;
      const segments = flow.segments ?? [{ file: flow.file }];
      for (const [segmentIndex, segment] of segments.entries()) {
        if (segment.providerPhase) {
          await callProvider(providerExecutable, segment.providerPhase, { ...context, segment: segment.file }, outputDir);
        }
        const junitPart = path.join(junitPartsDir, `${flow.id}-${segmentIndex + 1}.xml`);
        const maestroArgs = [
          'test', path.join(root, 'flows', segment.file),
          '--config', path.join(root, 'config.yaml'),
          '--format', 'JUNIT', '--output', junitPart,
          ...toMaestroEnvArgs(env),
        ];
        const result = await run('maestro', maestroArgs, {
          cwd: root,
          env: { ...process.env, APP_ID: appId, ...env },
          stdio: ['ignore', logStream, logStream],
        });
        if (result.code !== 0) throw new Error(`Maestro segment ${segment.file} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}`);
      }
    } catch (errorValue) {
      status = 'failed';
      error = redact(errorValue instanceof Error ? errorValue.message : String(errorValue));
      failure ??= errorValue;
    } finally {
      try { await fixtureCall(fixtureOrigin, fixtureToken, 'cleanup', { scenario: flow.fixture, testRunId, buildSha, slot }); } catch (cleanupError) {
        status = 'failed';
        error ??= 'fixture cleanup failed';
        failure ??= cleanupError;
      }
      try { await callProvider(providerExecutable, 'cleanup-flow', context, outputDir); } catch (cleanupError) {
        status = 'failed';
        error ??= 'provider flow cleanup failed';
        failure ??= cleanupError;
      }
    }
    flowResults.push({ id: flow.id, status, durationMs: Date.now() - started, error });
    if (failure) break;
  }

  try { await callProvider(providerExecutable, 'cleanup-run', providerContext(contract, outputDir, null), outputDir); } catch (cleanupError) { failure ??= cleanupError; }
  await new Promise((resolve) => logStream.end(resolve));
  logClosed = true;
  const limitedLog = await boundedSanitizedLog(rawLog, path.join(outputDir, 'maestro.sanitized.log'));
  await rm(rawLog, { force: true });
  await chmod(path.join(outputDir, 'maestro.sanitized.log'), 0o444);
  await mergeJunit(flowResults, path.join(outputDir, 'junit.xml'));

  const screenshots = await listFilesRecursive(screenshotDir, '.png');
  const screenshotManifest = [];
  for (const file of screenshots) {
    const bytes = await readFile(file);
    screenshotManifest.push({
      path: path.relative(outputDir, file).replaceAll(path.sep, '/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
    await chmod(file, 0o444);
  }
  await writeImmutableJson(path.join(outputDir, 'screenshots.json'), screenshotManifest);

  const completedAt = new Date().toISOString();
  const payload = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    evidenceKind: 'real-device',
    receiptId: sha256(`${testRunId}\0${slot}\0${attestation.providerRunId}\0${flowHash}`),
    contract,
    device: {
      physical: true,
      virtual: false,
      browser: false,
      providerName: attestation.providerName,
      providerRunId: attestation.providerRunId,
      deviceIdentifierHash: attestation.deviceIdentifierHash,
      model: attestation.deviceModel ?? device,
    },
    run: {
      completedAt,
      status: failure ? 'failed' : 'passed',
      fixtureVersion,
    },
    flowHash,
    flows: flowResults,
    artifacts: {
      junit: { path: 'junit.xml', sha256: sha256(await readFile(path.join(outputDir, 'junit.xml'), 'utf8')) },
      screenshots: { path: 'screenshots.json', count: screenshotManifest.length },
      limitedLog: { path: 'maestro.sanitized.log', ...limitedLog },
    },
  };
  await writeImmutableJson(path.join(outputDir, 'receipt.json'), sealReceipt(payload, hmacKey));
  process.stdout.write(`${JSON.stringify({ receipt: path.join(outputDir, 'receipt.json'), status: payload.run.status, slot })}\n`);
  if (failure) throw failure;
} catch (error) {
  if (logStream && !logClosed) {
    await new Promise((resolve) => logStream.end(resolve));
    logClosed = true;
  }
  if (rawLog && outputDir) {
    const sanitizedPath = path.join(outputDir, 'maestro.sanitized.log');
    try {
      await boundedSanitizedLog(rawLog, sanitizedPath);
      await rm(rawLog, { force: true });
      await chmod(sanitizedPath, 0o444);
    } catch { /* original fail-closed error remains authoritative */ }
  }
  process.stderr.write(`native E2E failed closed: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}

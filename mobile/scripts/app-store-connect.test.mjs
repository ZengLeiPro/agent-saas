import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import './app-store-upload-result.test.mjs';
import {
  classifyInternalBuildState,
  createAppStoreToken,
  validateInternalGroup,
} from './app-store-connect.mjs';

test('App Store token is a short-lived ES256 JWT with the requested key identity', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.parse('2026-09-10T00:00:00Z');
  const token = createAppStoreToken({
    keyId: 'WUQL8DV33D',
    issuerId: '69a6de84-4e94-47e3-e053-5b8c7c11a4d1',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    now,
  });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {
    alg: 'ES256',
    kid: 'WUQL8DV33D',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iss: '69a6de84-4e94-47e3-e053-5b8c7c11a4d1',
    iat: 1788998400,
    exp: 1788999300,
    aud: 'appstoreconnect-v1',
  });
  assert.equal(
    verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
});

test('internal TestFlight state distinguishes ready, blocked, failed and waiting builds', () => {
  assert.equal(classifyInternalBuildState('IN_BETA_TESTING'), 'ready');
  assert.equal(classifyInternalBuildState('MISSING_EXPORT_COMPLIANCE'), 'blocked');
  assert.equal(classifyInternalBuildState('PROCESSING_EXCEPTION'), 'failed');
  assert.equal(classifyInternalBuildState('EXPIRED'), 'failed');
  assert.equal(classifyInternalBuildState('READY_FOR_BETA_TESTING'), 'waiting');
  assert.equal(classifyInternalBuildState('PROCESSING'), 'waiting');
});

test('internal TestFlight group must match the reviewed all-builds group', () => {
  const group = {
    id: 'a21bd778-a7de-43ee-97ca-3f6f5877d237',
    attributes: {
      name: 'kaiyan',
      isInternalGroup: true,
      hasAccessToAllBuilds: true,
    },
  };
  const expected = { id: group.id, name: 'kaiyan' };
  assert.equal(validateInternalGroup(group, expected), group);
  assert.throws(() => validateInternalGroup({ ...group, id: 'wrong' }, expected));
  assert.throws(() =>
    validateInternalGroup(
      { ...group, attributes: { ...group.attributes, name: 'other' } },
      expected,
    ),
  );
  assert.throws(() =>
    validateInternalGroup(
      { ...group, attributes: { ...group.attributes, hasAccessToAllBuilds: false } },
      expected,
    ),
  );
});

// These tests use real Node child processes, pipes, signals, temporary keys and
// cancellation. Apple HTTP and xcrun are local doubles, never production calls.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppStoreClient, submitToTestFlight } from './app-store-connect.mjs';
import { SubmissionProgress, SUBMIT_LIMITS, runUploadProcess, uploadIpa } from './app-store-progress.mjs';

const limits = { ...SUBMIT_LIMITS, totalMs: 10_000, preflightMs: 1000, uploadMs: 3000, visibilityMs: 1000, processingMs: 1000, internalMs: 1000, heartbeatMs: 10, pollMs: 10 };
const identity = { appId: '1234567890', version: '1.0.0', buildNumber: '6.101.1', betaGroupId: 'a21bd778-a7de-43ee-97ca-3f6f5877d237', betaGroupName: 'fixture' };
const group = { id: identity.betaGroupId, attributes: { name: identity.betaGroupName, isInternalGroup: true, hasAccessToAllBuilds: true } };
const credentials = {
  keyId: 'TESTKEY001', issuerId: '69a6de84-4e94-47e3-e053-5b8c7c11a4d1',
  privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

function observer(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'asc-progress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const summaryPath = join(directory, 'summary.md');
  const logs = [];
  const progress = new SubmissionProgress({ limits, log: (line) => logs.push(line), summaryPath, ...overrides });
  return { directory, summaryPath, logs, progress, records: () => logs.map((line) => JSON.parse(line.slice(line.indexOf('{')))) };
}

function fakeClient(builds = [null, 'PROCESSING', 'VALID'], internal = ['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING']) {
  const calls = [];
  return {
    calls,
    async request(path, options) {
      options.signal.throwIfAborted();
      calls.push(path);
      if (path.startsWith('/betaGroups?')) return { data: [group] };
      if (path.endsWith('/buildBetaDetail')) return { data: { attributes: { internalBuildState: internal.length > 1 ? internal.shift() : internal[0] } } };
      const state = builds.length > 1 ? builds.shift() : builds[0];
      return { data: state ? [{ id: 'fixture-build', attributes: { processingState: state } }] : [] };
    },
  };
}

for (const alreadyPresent of [false, true]) {
  test(`submission reports all states and ${alreadyPresent ? 'skips an existing' : 'uploads a new'} build`, async (t) => {
    const item = observer(t);
    let uploads = 0;
    const client = fakeClient(alreadyPresent ? ['PROCESSING', 'VALID'] : [null, null, 'PROCESSING', 'VALID']);
    const result = await submitToTestFlight({ client, identity, progress: item.progress, upload: async (phase) => { uploads++; phase.state('RUNNING'); await phase.sleep(50); return { accepted: true, evidence: ['altool-banner'] }; } });
    assert.equal(uploads, alreadyPresent ? 0 : 1);
    assert.equal(result.uploadStatus, alreadyPresent ? 'already-present' : 'uploaded');
    assert.equal(result.betaDetail.attributes.internalBuildState, 'IN_BETA_TESTING');
    assert.ok(item.records().some((r) => r.stage === 'apple-processing' && r.state === 'VALID'));
    assert.ok(item.records().some((r) => r.stage === 'internal-testflight' && r.event === 'completed'));
    assert.ok(client.calls.filter((p) => p.startsWith('/builds?')).every((p) => p.includes('6.101.1') && p.includes('1.0.0')));
    assert.doesNotMatch(item.logs.join('\n'), /"event":"failed"/u);
    const count = item.logs.length;
    await delay(30);
    assert.equal(item.logs.length, count, 'no heartbeat after completion');
  });
}

for (const state of ['FAILED', 'INVALID', 'MISSING_EXPORT_COMPLIANCE', 'EXPIRED', 'PROCESSING_EXCEPTION']) {
  test(`Apple state ${state} terminates without claiming readiness`, async (t) => {
    const item = observer(t);
    const client = ['FAILED', 'INVALID'].includes(state) ? fakeClient(['VALID', state]) : fakeClient(['VALID'], [state]);
    await assert.rejects(submitToTestFlight({ client, identity, progress: item.progress, upload: () => assert.fail('must not upload') }));
    assert.ok(item.records().some((r) => r.event === 'failed' && r.state === state));
    assert.doesNotMatch(readFileSync(item.summaryPath, 'utf8'), /IN_BETA_TESTING/u);
  });
}

test('unknown Apple state is bounded and cannot leak server text', async (t) => {
  const item = observer(t, { limits: { ...limits, internalMs: 60 } });
  await assert.rejects(submitToTestFlight({ client: fakeClient(['VALID'], ['PRIVATE_SENTINEL']), identity, progress: item.progress }), /deadline/u);
  assert.ok(item.records().some((r) => r.state === 'UNKNOWN' && r.event === 'timed-out'));
  assert.doesNotMatch(item.logs.join('') + readFileSync(item.summaryPath, 'utf8'), /PRIVATE_SENTINEL/u);
});

test('oversized output is drained with heartbeats but never accepted as a complete receipt', async (t) => {
  const item = observer(t);
  await assert.rejects(item.progress.run('upload', 3000, (phase) => runUploadProcess(process.execPath, ['-e', `
    process.stdout.write('PRIVATE_' + 'SENTINEL');
    process.stderr.write('-----BEGIN PRIVATE KEY-----\\nSECRET_LINE\\n-----END PRIVATE KEY-----');
    process.stdout.write('x'.repeat(2 * 1024 * 1024));
    setTimeout(() => process.exit(0), 150);
  `], { phase })), /OUTPUT_LIMIT_EXCEEDED/u);
  const records = item.records();
  assert.ok(records.some((r) => r.event === 'heartbeat' && r.toolOutputBytes > 1024 * 1024));
  assert.equal(records.at(-1).event, 'failed');
  assert.doesNotMatch(item.logs.join('') + readFileSync(item.summaryPath, 'utf8'), /PRIVATE_SENTINEL|SECRET_LINE|BEGIN PRIVATE KEY/u);
});

test('upload failures retain only bounded Apple codes, not raw stdout/stderr', async (t) => {
  const item = observer(t);
  await assert.rejects(item.progress.run('upload', 3000, (phase) => runUploadProcess(process.execPath, ['-e', "console.error('PRIVATE_SENTINEL ITMS-90165'); process.exitCode=7"], { phase })), (error) => {
    assert.match(error.message, /exit=7.*ITMS-90165/u);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/u);
    return true;
  });
});

test('spawn errors finish promptly and do not leave a heartbeat', async (t) => {
  const item = observer(t);
  await assert.rejects(item.progress.run('upload', 3000, (phase) => runUploadProcess('/missing-asc-tool', [], { phase })), /ENOENT/u);
  const count = item.logs.length;
  await delay(30);
  assert.equal(item.logs.length, count);
});

test('timeout escalates to SIGKILL for the entire upload process group', async (t) => {
  const item = observer(t);
  const pidFile = join(item.directory, 'child.pid');
  await assert.rejects(item.progress.run('upload', 1000, (phase) => runUploadProcess(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'inherit'});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
  `], { phase, killGraceMs: 50 })), /deadline/u);
  assert.ok(existsSync(pidFile), 'the real helper must have started');
  const pid = readFileSync(pidFile, 'utf8');
  for (let n = 0; n < 30; n++) {
    const status = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
    if (!status || status.startsWith('Z')) return;
    await delay(20);
  }
  assert.fail('upload helper still running after timeout');
});

test('one overall deadline bounds consecutive stages instead of resetting the timer', async (t) => {
  const item = observer(t, { limits: { ...limits, totalMs: 200 } });
  await item.progress.run('inspect', 1000, (phase) => phase.sleep(80));
  await assert.rejects(item.progress.run('apple-processing', 1000, (phase) => phase.sleep(1000)), /deadline/u);
  await assert.rejects(item.progress.run('internal-testflight', 1000, () => assert.fail('deadline was reset')), /deadline/u);
  assert.equal(SUBMIT_LIMITS.totalMs / 60_000, 105);
});

test('client request and retry delay honour the same stage cancellation signal', async (t) => {
  for (const hanging of [true, false]) {
    const item = observer(t);
    let requests = 0;
    const client = new AppStoreClient(credentials, { fetchImpl: async (_url, options) => {
      requests++;
      if (!hanging) return new Response('{}', { status: 503 });
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
    await assert.rejects(item.progress.run('inspect', 80, (phase) => client.request('/builds', { signal: phase.signal })), /deadline/u);
    assert.equal(requests, 1);
  }
});

test('API errors never print response bodies or authentication tokens', async () => {
  const client = new AppStoreClient(credentials, { fetchImpl: async () => new Response(JSON.stringify({ errors: [{ detail: 'PRIVATE_SENTINEL', code: 'PRIVATE_SENTINEL' }] }), { status: 403 }) });
  await assert.rejects(client.request('/betaGroups'), (error) => {
    assert.match(error.message, /HTTP 403/u);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|PRIVATE KEY|Bearer/u);
    return true;
  });
});

test('accepted upload after client error is reconciled once without another upload', async (t) => {
  const item = observer(t);
  let uploads = 0;
  const result = await submitToTestFlight({ client: fakeClient([null, 'PROCESSING', 'VALID']), identity, progress: item.progress, upload: async () => { uploads++; throw new Error('upload failed'); } });
  assert.equal(result.uploadStatus, 'accepted-before-client-error');
  assert.equal(uploads, 1);
});

test('cancellation does not reconcile, reupload or produce a readiness event', async (t) => {
  const controller = new AbortController();
  const item = observer(t, { signal: controller.signal });
  const client = fakeClient();
  await assert.rejects(submitToTestFlight({ client, identity, progress: item.progress, upload: async (phase) => {
    controller.abort(new Error('cancelled by test'));
    phase.signal.throwIfAborted();
  } }), /cancelled/u);
  assert.equal(client.calls.filter((p) => p.startsWith('/builds?')).length, 1);
  assert.equal(item.records().at(-1).event, 'cancelled');
});

for (const mode of ['success', 'missing-file', 'spawn-error', 'cancelled', 'zero-exit-error', 'mutated-copy']) {
  test(`temporary P8 is cleaned on ${mode}, including a real named read-only IPA`, async (t) => {
    const item = observer(t);
    const bin = join(item.directory, 'bin');
    mkdirSync(bin);
    const ipa = join(item.directory, 'fixture.ipa');
    writeFileSync(ipa, 'EXACT_IPA_BYTES');
    writeFileSync(join(bin, 'xcrun'), `#!${process.execPath}\n
      const fs=require('node:fs'), path=require('node:path');
      const args=process.argv.slice(2), ipa=args[args.indexOf('--file')+1];
      if (!ipa.endsWith('/upload.ipa') || fs.readFileSync(ipa,'utf8') !== 'EXACT_IPA_BYTES') process.exit(2);
      if ((fs.statSync(ipa).mode & 511)!==256) process.exit(5);
      // A helper with no inherited IPA descriptor can reopen the real path.
      require('node:child_process').execFileSync(process.execPath,['-e', 'require("node:fs").readFileSync(process.argv[1])', ipa]);
      const dir=process.env.API_PRIVATE_KEYS_DIR;
      const key=path.join(dir,fs.readdirSync(dir)[0]);
      if ((fs.statSync(key).mode & 511)!==384 || (fs.statSync(dir).mode & 511)!==448) process.exit(3);
      if (process.env.APP_STORE_CONNECT_API_KEY_P8) process.exit(4);
      ${mode === 'cancelled' ? 'setInterval(()=>{},1000);' : mode === 'zero-exit-error' ? 'console.error("ERROR: Failed to upload package. PRIVATE_SENTINEL");' : mode === 'mutated-copy' ? 'fs.chmodSync(ipa,384); fs.writeFileSync(ipa,"CHANGED_IPA_BYTES"); console.log("UPLOAD SUCCEEDED");' : 'console.log("UPLOAD SUCCEEDED");'}
    `, { mode: 0o700 });
    const oldPath = process.env.PATH;
    const oldKey = process.env.APP_STORE_CONNECT_API_KEY_P8;
    process.env.APP_STORE_CONNECT_API_KEY_P8 = credentials.privateKey;
    process.env.PATH = mode === 'spawn-error' ? item.directory : `${bin}:${oldPath}`;
    t.after(() => { process.env.PATH = oldPath; if (oldKey === undefined) delete process.env.APP_STORE_CONNECT_API_KEY_P8; else process.env.APP_STORE_CONNECT_API_KEY_P8 = oldKey; });
    const promise = item.progress.run('upload', mode === 'cancelled' ? 500 : 3000,
      (phase) => uploadIpa(mode === 'missing-file' ? '/missing-fixture.ipa' : ipa, credentials, join(item.directory, 'keys'), phase));
    if (mode === 'success') await promise; else await assert.rejects(promise);
    assert.deepEqual(readdirSync(join(item.directory, 'keys')), []);
    assert.doesNotMatch(item.logs.join('') + readFileSync(item.summaryPath, 'utf8'), /BEGIN PRIVATE KEY/u);
  });
}

for (const outcome of ['success', 'cancelled', 'apple-failed', 'zero-exit-error', 'empty-output']) {
  test(`real CLI ${outcome}: cleanup and truthful receipt`, async (t) => {
  const item = observer(t);
  const bin = join(item.directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'xcrun'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(item.directory, 'started'))},'yes'); ${outcome === 'cancelled' ? 'setInterval(()=>{},1000);' : outcome === 'zero-exit-error' ? 'console.error("ERROR: Failed to upload package. PRIVATE_SENTINEL");' : outcome === 'empty-output' ? '' : 'console.log("UPLOAD SUCCEEDED");'}`, { mode: 0o700 });
  const stub = join(item.directory, 'network.mjs');
  writeFileSync(stub, `let reads=0; globalThis.fetch=async (url)=>new Response(JSON.stringify({data:url.includes('/betaGroups?')?[${JSON.stringify(group)}]:url.endsWith('/buildBetaDetail')?{attributes:{internalBuildState:'IN_BETA_TESTING'}}:${['zero-exit-error', 'empty-output'].includes(outcome) ? 'true' : 'reads++===0'}?[]:[{id:'fixture-build',attributes:{processingState:'${outcome === 'apple-failed' ? 'INVALID' : 'VALID'}'}}]}));`);
  const ipa = join(item.directory, 'fixture.ipa');
  writeFileSync(ipa, 'fixture');
  writeFileSync(`${ipa}.source.json`, JSON.stringify(identity));
  const result = join(item.directory, 'result.json');
  const child = spawn(process.execPath, ['--import', stub, join(import.meta.dirname, 'app-store-connect.mjs'), '--ipa', ipa, '--result', result], {
    env: { ...process.env, HOME: item.directory, PATH: `${bin}:${process.env.PATH}`, APP_STORE_CONNECT_APP_ID: identity.appId,
      TESTFLIGHT_INTERNAL_GROUP_ID: identity.betaGroupId, TESTFLIGHT_INTERNAL_GROUP_NAME: identity.betaGroupName,
      APP_STORE_CONNECT_API_KEY_P8: credentials.privateKey, APP_STORE_CONNECT_API_KEY_ID: credentials.keyId,
      APP_STORE_CONNECT_ISSUER_ID: credentials.issuerId, GITHUB_STEP_SUMMARY: item.summaryPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 5000);
  const closed = new Promise((resolve) => child.once('close', (code) => { clearTimeout(watchdog); resolve(code); }));
  t.after(() => { clearTimeout(watchdog); child.kill('SIGKILL'); });
  for (let n = 0; n < 200 && !existsSync(join(item.directory, 'started')); n++) await delay(10);
  assert.ok(existsSync(join(item.directory, 'started')), logs);
  if (outcome === 'cancelled') child.kill('SIGTERM');
  const code = await closed;
  if (outcome === 'success') {
    assert.equal(code, 0, logs);
    const receipt = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(receipt.processingState, 'VALID');
    assert.equal(receipt.internalBuildState, 'IN_BETA_TESTING');
    assert.equal(receipt.buildNumber, identity.buildNumber);
  } else {
    assert.notEqual(code, 0);
    assert.match(logs, outcome === 'cancelled' ? /cancelled/u : outcome === 'apple-failed' ? /INVALID/u : outcome === 'zero-exit-error' ? /TOOL_REPORTED_ERROR/u : /NO_SUCCESS_EVIDENCE/u);
    if (['zero-exit-error', 'empty-output'].includes(outcome)) {
      assert.doesNotMatch(logs, /apple-processing|build-visibility|internal-testflight/u);
      assert.doesNotMatch(logs, /PRIVATE_SENTINEL|Submission cancelled/u);
    }
    assert.doesNotMatch(logs, /IN_BETA_TESTING/u);
    assert.equal(existsSync(result), false);
  }
  assert.doesNotMatch(logs, /BEGIN PRIVATE KEY/u);
  assert.deepEqual(readdirSync(join(item.directory, '.appstoreconnect/private_keys')), []);
});
}

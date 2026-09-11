import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { UploadOutput, UPLOAD_OUTPUT_LIMIT } from './app-store-upload-result.mjs';
import { SubmissionProgress, SUBMIT_LIMITS, UploadIntegrityError, runUploadProcess } from './app-store-progress.mjs';
import { submitToTestFlight } from './app-store-connect.mjs';

// Synthetic, credential-free fixtures. Xcode 26 zero-exit ERROR format is from
// https://github.com/fastlane/fastlane/pull/29740, not a claim about a live IPA.
const success = JSON.stringify({ 'tool-version': '8.003', 'success-message': "No errors uploading '/private/upload.ipa'." });
function parse(stdout = '', stderr = '', code = 0, signal = null) {
  const parser = new UploadOutput();
  parser.consume('stdout', Buffer.from(stdout));
  parser.consume('stderr', Buffer.from(stderr));
  return parser.finish(code, signal);
}

for (const [name, stdout, stderr] of [
  ['legacy JSON', success, ''],
  ['JSON on stderr', '', success],
  ['BOM JSON', `\uFEFF${success}`, ''],
  ['mixed log and JSON', `INFO: beginning upload\n${success}`, ''],
  ['upload banner', 'UPLOAD SUCCEEDED\n', ''],
  ['banner with no errors', '', 'UPLOAD SUCCEEDED with no errors\n'],
  ['JSON success and empty errors', JSON.stringify({ 'success-message': "No errors uploading 'upload.ipa'.", 'product-errors': [], warnings: [{ message: 'warning', code: -1030 }] }), ''],
  ['separate informational stderr', success, 'INFO: upload complete\n'],
]) {
  test(`altool success requires positive evidence: ${name}`, () => {
    const result = parse(stdout, stderr);
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'UPLOAD_REPORTED_SUCCESS');
    assert.ok(result.evidence.length);
    assert.equal(result.stdoutBytes, Buffer.byteLength(stdout));
    assert.doesNotMatch(JSON.stringify(result), /\/private\//u);
  });
}

for (const [name, stdout, stderr, code, reason] of [
  ['Xcode 26 zero-exit failure', '', '2025-10-31 11:34:44.727 ERROR: [altool.102BA2C00] Failed to upload package.', 0, 'TOOL_REPORTED_ERROR'],
  ['old altool Error', '*** Error: Unable to validate archive upload.ipa', '', 0, 'TOOL_REPORTED_ERROR'],
  ['JSON product-errors', '{"product-errors":[{"code":-19232,"message":"PRIVATE_SENTINEL"}]}', '', 0, 'TOOL_REPORTED_ERROR'],
  ['JSON errors', '{"errors":[{"detail":"PRIVATE_SENTINEL"}]}', '', 0, 'TOOL_REPORTED_ERROR'],
  ['nested JSON error', '{"response":{"error":"PRIVATE_SENTINEL"}}', '', 0, 'TOOL_REPORTED_ERROR'],
  ['explicit unsuccessful JSON', '{"success":false}', '', 0, 'TOOL_REPORTED_ERROR'],
  ['structured error beats success', success.replace(/}$/, ',"product-errors":[{"code":-19241}]}'), '', 0, 'TOOL_REPORTED_ERROR'],
  ['stderr error beats stdout success', success, 'ERROR: PRIVATE_SENTINEL ITMS-90165', 0, 'TOOL_REPORTED_ERROR'],
  ['stdout error beats stderr success', 'UPLOAD FAILED', success, 0, 'TOOL_REPORTED_ERROR'],
  ['nonzero beats success', success, '', 7, 'PROCESS_EXIT_ERROR'],
  ['signal beats success', success, '', null, 'SIGTERM'],
  ['empty output', '', '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['whitespace only', ' \n', '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['help text', 'Usage: altool --upload-app', '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['unrecognized JSON', '{"status":"ok"}', '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['unrelated success message', '{"success-message":"No errors validating upload.ipa"}', '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['quoted banner is not a receipt', '{"message":"UPLOAD SUCCEEDED"}', '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['nested success is not a receipt', `{"wrapper":${success}}`, '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['top-level array not a receipt', `[${success}]`, '', 0, 'NO_SUCCESS_EVIDENCE'],
  ['partial JSON', '{"success-message":"No errors uploading', '', 0, 'MALFORMED_OUTPUT'],
  ['trailing partial JSON beats success', `${success}\n{`, '', 0, 'MALFORMED_OUTPUT'],
]) {
  test(`altool refuses false success: ${name}`, () => {
    const result = parse(stdout, stderr, code, reason === 'SIGTERM' ? 'SIGTERM' : null);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason === 'SIGTERM' ? 'PROCESS_EXIT_ERROR' : reason);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/u);
  });
}

test('receipt identifiers are validated and ambiguity is rejected', () => {
  const id = 'a21bd778-a7de-43ee-97ca-3f6f5877d237';
  assert.equal(parse(`UPLOAD SUCCEEDED\nDelivery UUID: ${id}`).deliveryId, id);
  assert.equal(parse(`${success.slice(0, -1)},"delivery-id":"PRIVATE_SENTINEL"}`).deliveryId, null);
  assert.equal(parse(`UPLOAD SUCCEEDED\nDelivery UUID: ${id}\nDelivery UUID: b21bd778-a7de-43ee-97ca-3f6f5877d237`).reason, 'AMBIGUOUS_RECEIPT');
});

test('JSON UTF-8 and error markers survive arbitrary split chunks and stream interleaving', () => {
  const parser = new UploadOutput();
  const bytes = Buffer.from(success.replace('upload.ipa', '上传.ipa'));
  for (const byte of bytes) parser.consume('stdout', Buffer.from([byte]));
  parser.consume('stderr', Buffer.from('ER'));
  parser.consume('stdout', Buffer.from('\n'));
  parser.consume('stderr', Buffer.from('ROR: Failed to up'));
  parser.consume('stderr', Buffer.from('load package ITMS-90165'));
  const result = parser.finish(0);
  assert.equal(result.reason, 'TOOL_REPORTED_ERROR');
  assert.ok(result.errorCodes.includes('ITMS-90165'));
});

test('bounded output keeps early failure even when a later success banner replaces the old tail', () => {
  const parser = new UploadOutput();
  parser.consume('stderr', Buffer.from('ERROR: Unsupported file /dev/fd/3\nITMS-90165\n'));
  for (let n = 0; n < 50; n++) parser.consume('stderr', Buffer.alloc(16 * 1024, 120));
  parser.consume('stdout', Buffer.from(success));
  assert.ok(parser.streams.stderr.retained <= UPLOAD_OUTPUT_LIMIT);
  const result = parser.finish(0);
  assert.equal(result.reason, 'TOOL_REPORTED_ERROR');
  assert.ok(result.hints.includes('CHECK_IPA_FILE'));
  assert.ok(result.errorCodes.includes('ITMS-90165'));
});

const identity = { appId: '1234567890', version: '1.0.0', buildNumber: '6.101.1', betaGroupId: 'test-group', betaGroupName: 'fixture' };
const group = { id: identity.betaGroupId, attributes: { name: identity.betaGroupName, isInternalGroup: true, hasAccessToAllBuilds: true } };
function harness(t, changes = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'asc-result-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logs = [];
  const summaryPath = join(directory, 'summary.md');
  const limits = { ...SUBMIT_LIMITS, totalMs: 5000, preflightMs: 1000, uploadMs: 2000, visibilityMs: 100, processingMs: 1000, internalMs: 1000, pollMs: 5, heartbeatMs: 10, ...changes };
  const progress = new SubmissionProgress({ limits, summaryPath, log: (line) => logs.push(JSON.parse(line.slice(line.indexOf('{')))) });
  return { progress, logs, summaryPath };
}
function clientFixture(sequence) {
  let requests = 0;
  return {
    get requests() { return requests; },
    async request(path) {
      if (path.startsWith('/betaGroups?')) return { data: [group] };
      if (path.endsWith('/buildBetaDetail')) return { data: { attributes: { internalBuildState: 'IN_BETA_TESTING' } } };
      requests++;
      const state = sequence.length > 1 ? sequence.shift() : sequence[0];
      return { data: state ? [{ id: 'build-101', attributes: { processingState: state } }] : [] };
    },
  };
}

for (const content of ['ERROR: Failed to upload package.', '{"product-errors":[{"code":-19232}]}', '']) {
  test(`real zero-exit child cannot enter long processing without evidence: ${content || 'empty'}`, async (t) => {
    const item = harness(t);
    const client = clientFixture([null]);
    await assert.rejects(submitToTestFlight({ client, identity, progress: item.progress,
      upload: (phase) => runUploadProcess(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(content)})`], { phase }),
    }), /upload not confirmed/u);
    assert.equal(client.requests, 2, 'only preflight and one exact reconciliation');
    assert.ok(item.logs.some((r) => r.event === 'upload-result' && r.uploadDiagnostic.accepted === false));
    assert.ok(!item.logs.some((r) => ['build-visibility', 'apple-processing', 'internal-testflight'].includes(r.stage)));
    assert.match(readFileSync(item.summaryPath, 'utf8'), /upload diagnostic/i);
  });
}

test('real positive receipt logs final upload state and safe metadata before polling', async (t) => {
  const item = harness(t);
  const result = await submitToTestFlight({ client: clientFixture([null, 'PROCESSING', 'VALID']), identity, progress: item.progress,
    upload: (phase) => runUploadProcess(process.execPath, ['-e', `setTimeout(()=>console.log(${JSON.stringify(success)}), 80)`], { phase }),
  });
  assert.equal(result.uploadEvidence.accepted, true);
  assert.ok(item.logs.some((r) => r.stage === 'upload' && r.event === 'heartbeat'));
  assert.ok(item.logs.some((r) => r.stage === 'upload' && r.event === 'completed' && r.state === 'UPLOAD_REPORTED_SUCCESS'));
  assert.ok(item.logs.every((r) => r.appId === identity.appId && r.buildNumber === identity.buildNumber));
  assert.equal(result.betaDetail.attributes.internalBuildState, 'IN_BETA_TESTING');
  const count = item.logs.length;
  await delay(20);
  assert.equal(item.logs.length, count);
});

test('positive tool receipt but absent build times out in visibility, never claims Apple processing', async (t) => {
  const item = harness(t);
  let uploads = 0;
  await assert.rejects(submitToTestFlight({ client: clientFixture([null]), identity, progress: item.progress,
    upload: async () => { uploads++; return parse(success); },
  }), /Apple processing is NOT confirmed/u);
  assert.equal(uploads, 1);
  assert.ok(item.logs.some((r) => r.stage === 'build-visibility' && r.event === 'timed-out'));
  assert.ok(!item.logs.some((r) => r.stage === 'apple-processing'));
});

test('independent exact build can reconcile a zero-exit error without pretending the tool succeeded', async (t) => {
  const item = harness(t);
  const result = await submitToTestFlight({ client: clientFixture([null, 'PROCESSING', 'VALID']), identity, progress: item.progress,
    upload: (phase) => runUploadProcess(process.execPath, ['-e', "console.error('ERROR: Failed to upload package.')"], { phase }),
  });
  assert.equal(result.uploadStatus, 'accepted-before-client-error');
  assert.equal(result.uploadEvidence.accepted, false);
  assert.ok(item.logs.some((r) => r.stage === 'upload' && r.event === 'failed'));
  assert.equal(result.build.attributes.processingState, 'VALID');
});

test('identity diagnostics reject injection instead of printing arbitrary input', () => {
  const logs = [];
  const progress = new SubmissionProgress({ log: (line) => logs.push(line) });
  assert.throws(() => progress.identify({ ...identity, buildNumber: 'PRIVATE_SENTINEL\n::error::' }));
  assert.deepEqual(logs, []);
});

test('upload integrity failure cannot be overridden by finding an Apple build', async (t) => {
  const item = harness(t);
  const client = clientFixture([null, 'VALID']);
  await assert.rejects(submitToTestFlight({ client, identity, progress: item.progress,
    upload: async () => { throw new UploadIntegrityError('Uploaded IPA copy changed'); },
  }), UploadIntegrityError);
  assert.equal(client.requests, 1, 'no reconciliation may mask changed IPA bytes');
  assert.ok(!item.logs.some((r) => r.stage === 'reconcile-upload'));
});

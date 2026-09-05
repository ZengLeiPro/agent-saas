import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SLOTS, sealReceipt } from '../scripts/evidence-lib.mjs';
import { validateDeviceMatrix } from '../scripts/validate-device-matrix.mjs';
import { validateReceiptSet } from '../scripts/validate-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileRoot = path.resolve(root, '../..');
const fixtureRoot = path.join(root, 'tests/fixtures/four-slot-pass');
const fixtureKey = 'm60-02-deterministic-fixture-key-32chars'; // Mock-only HMAC key.
const fixtureSha = '547f5f87a8cea7696135f611a42e2dcdcaebd9f5f';

async function receiptPaths(base = fixtureRoot) {
  return Promise.all(REQUIRED_SLOTS.map(async (slot) => {
    const file = path.join(base, slot, 'receipt.json');
    await readFile(file);
    return file;
  }));
}

async function withFixtureCopy(callback) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm60-02-'));
  try {
    await cp(fixtureRoot, temp, { recursive: true });
    return await callback(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function mutateAndReseal(file, mutate) {
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  mutate(receipt);
  delete receipt.integrity;
  await writeFile(file, `${JSON.stringify(sealReceipt(receipt, fixtureKey), null, 2)}\n`);
}

test('coverage manifest maps every authoritative capability to an existing independent flow', async () => {
  const coverage = JSON.parse(await readFile(path.join(root, 'coverage.json'), 'utf8'));
  const covered = new Set(coverage.flows.flatMap((flow) => flow.capabilities));
  assert.deepEqual([...covered].sort(), [...coverage.requiredCapabilities].sort());
  assert.equal(coverage.flows.length, 11);
  for (const flow of coverage.flows) {
    const files = [flow.file, ...(flow.segments ?? []).map((segment) => segment.file)];
    for (const file of files) {
      const source = await readFile(path.join(root, 'flows', file), 'utf8');
      assert.match(source, /^appId: \$\{APP_ID\}/);
      assert.match(source, /takeScreenshot:/);
    }
    const entrySource = await readFile(path.join(root, 'flows', flow.file), 'utf8');
    assert.ok(entrySource.includes('clearState: true') || ['share-intent', 'upgrade-pending'].includes(flow.id));
  }
});

test('Maestro configuration and flows contain no hardcoded account, OTP, secret, or service origin', async () => {
  const files = [
    path.join(root, 'config.yaml'),
    ...JSON.parse(await readFile(path.join(root, 'coverage.json'), 'utf8')).flows.flatMap((flow) =>
      [flow.file, ...(flow.segments ?? []).map((segment) => segment.file)].map((file) => path.join(root, 'flows', file))),
    path.join(root, 'helpers/login-a-password.yaml'),
    path.join(root, 'helpers/login-b-password.yaml'),
    path.join(root, 'helpers/login-a-otp.yaml'),
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /https?:\/\//i, file);
    assert.doesNotMatch(source, /(?:password|token|secret|otp)\s*:\s*(?!\$\{)[^\s]+/i, file);
  }
});

test('app exposes the stable native IDs consumed by Maestro', async () => {
  const sources = await Promise.all([
    'app/login.tsx', 'app/(tabs)/_layout.tsx', 'app/(tabs)/chat/index.tsx', 'app/(tabs)/settings/index.tsx',
    'app/chat/[sessionId].tsx', 'app/share-target.tsx', 'src/components/ConnectionBanner.tsx',
    'src/components/SessionRow.tsx', 'src/components/chat/ChatInput.tsx', 'src/components/chat/MessageItem.tsx',
    'src/components/chat/ModelPicker.tsx', 'src/components/overlays/DropdownMenu.tsx',
    // 会话页顶栏（返回三态 / Agent 目标入口 / 用量胶囊）已拆成独立组件。
    'src/components/chat/ChatSessionHeader.tsx',
    // 交互区/队列条与表单体已拆成独立组件，稳定 ID 随代码一起搬到这些文件。
    'src/components/chat/AskUserPromptPanel.tsx', 'src/components/chat/QueuedMessageBar.tsx',
    // 会话列表已拆成 src/components/sessions/*，列表本体的稳定 ID 随代码搬到这里。
    'src/components/sessions/SessionListView.tsx',
    'src/components/chat/blocks/AskUserBlock.tsx', 'src/components/chat/blocks/PermissionBlock.tsx',
  ].map((relative) => readFile(path.join(mobileRoot, relative), 'utf8')));
  const joined = sources.join('\n');
  for (const id of [
    'login-screen', 'login-username-input', 'login-password-input', 'login-otp-input', 'login-submit',
    'chat-session-list', 'chat-home-screen', 'logout-button', 'account-username', 'agent-target-picker',
    'chat-composer-input', 'chat-send-button', 'chat-attachment-button', 'chat-microphone-button',
    'canonical-interaction-zone', 'ask-user-submit', 'permission-allow-button', 'connection-banner',
    'interaction-counter', 'interaction-prev', 'interaction-next', 'queued-message-bar',
    'share-target-screen', 'share-target-send', 'settings-screen',
  ]) assert.ok(joined.includes(id), `missing native test ID: ${id}`);
});

test('receipt schema is strict and names all four native evidence slots', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'schema/receipt.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.contract.properties.slot.enum, REQUIRED_SLOTS);
  assert.deepEqual(schema.properties.evidenceKind.enum, ['real-device', 'deterministic-mock']);
});

test('deterministic four-slot mock fixture passes only explicit mock validation', async () => {
  const paths = await receiptPaths();
  const result = await validateReceiptSet({ receiptPaths: paths, expectedBuildSha: fixtureSha, hmacKey: fixtureKey, mode: 'mock' });
  assert.deepEqual(result.slots, REQUIRED_SLOTS);
  await assert.rejects(() => validateReceiptSet({ receiptPaths: paths, expectedBuildSha: fixtureSha, hmacKey: fixtureKey, mode: 'real' }), /cannot satisfy real evidence/);
});

test('tampered receipt fails closed', async () => withFixtureCopy(async (base) => {
  const file = path.join(base, 'ios-minimum/receipt.json');
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  receipt.contract.version = 'tampered';
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(async () => validateReceiptSet({ receiptPaths: await receiptPaths(base), expectedBuildSha: fixtureSha, hmacKey: fixtureKey, mode: 'mock' }), /tampered|HMAC/);
}));

test('validly sealed cross-SHA receipt still fails', async () => withFixtureCopy(async (base) => {
  await mutateAndReseal(path.join(base, 'android-flagship/receipt.json'), (receipt) => {
    receipt.contract.buildSha = 'a'.repeat(40);
    receipt.contract.sourceHead = 'a'.repeat(40);
  });
  await assert.rejects(async () => validateReceiptSet({ receiptPaths: await receiptPaths(base), expectedBuildSha: fixtureSha, hmacKey: fixtureKey, mode: 'mock' }), /cross-SHA/);
}));

test('simulator/browser receipt cannot satisfy real-device validation', async () => withFixtureCopy(async (base) => {
  for (const file of await receiptPaths(base)) await mutateAndReseal(file, (receipt) => { receipt.evidenceKind = 'real-device'; });
  await assert.rejects(async () => validateReceiptSet({ receiptPaths: await receiptPaths(base), expectedBuildSha: fixtureSha, hmacKey: fixtureKey, mode: 'real' }), /simulator|forbidden/);
}));

test('replayed testRunId/provider run is rejected even with a valid seal', async () => withFixtureCopy(async (base) => {
  const source = JSON.parse(await readFile(path.join(base, 'ios-minimum/receipt.json'), 'utf8'));
  await mutateAndReseal(path.join(base, 'ios-latest/receipt.json'), (receipt) => {
    receipt.contract.testRunId = source.contract.testRunId;
    receipt.device.providerRunId = source.device.providerRunId;
  });
  await assert.rejects(async () => validateReceiptSet({ receiptPaths: await receiptPaths(base), expectedBuildSha: fixtureSha, hmacKey: fixtureKey, mode: 'mock' }), /replayed/);
}));

test('missing evidence slot fails closed', async () => {
  const paths = await receiptPaths();
  await assert.rejects(() => validateReceiptSet({ receiptPaths: paths.slice(0, 3), expectedBuildSha: fixtureSha, hmacKey: fixtureKey, mode: 'mock' }), /four-slot evidence incomplete/);
});

test('device matrix contract requires explicit provider and exact four slots', () => {
  const matrix = REQUIRED_SLOTS.map((slot) => {
    const ios = slot.startsWith('ios');
    return {
      slot,
      platform: ios ? 'ios' : 'android',
      device: `configured-${slot}`,
      osVersion: ios ? (slot.endsWith('minimum') ? 'minimum-configured' : 'latest-configured') : 'configured',
      osRole: ios ? (slot.endsWith('minimum') ? 'minimum' : 'latest') : 'current',
      deviceClass: slot === 'android-flagship' ? 'flagship' : slot === 'android-low-end-small' ? 'low-end-small' : 'configured-ios',
      appId: ios ? 'configured.ios' : 'configured.android', version: 'fixture', signingFingerprint: 'ab'.repeat(32),
      providerExecutable: '/opt/configured/mobile-provider', executionTarget: 'self-hosted', runnerLabels: ['self-hosted', slot],
    };
  });
  assert.equal(validateDeviceMatrix(matrix).length, 4);
  assert.throws(() => validateDeviceMatrix(matrix.slice(1)), /exactly 4/);
  assert.throws(() => validateDeviceMatrix(matrix.map((entry) => ({ ...entry, runnerLabels: ['ubuntu-latest'] }))), /self-hosted runner label/);
});

test('provider runner contract requires all authoritative fields and secret injection names', async () => {
  const source = await readFile(path.join(root, 'scripts/run-native-e2e.mjs'), 'utf8');
  for (const field of ['platform', 'device', 'osVersion', 'deviceClass', 'buildSha', 'appId', 'version', 'signingFingerprint', 'testRunId']) {
    assert.ok(source.includes(`'${field}'`), `runner missing --${field}`);
  }
  assert.doesNotMatch(source, /https?:\/\/[A-Za-z0-9]/);
  for (const secret of ['MOBILE_E2E_ACCOUNTS_JSON', 'MOBILE_E2E_SERVICE_ORIGIN', 'MOBILE_E2E_OTP', 'MOBILE_E2E_FIXTURE_TOKEN', 'MOBILE_E2E_ARTIFACTS_JSON', 'MOBILE_E2E_RECEIPT_HMAC_KEY']) {
    assert.ok(source.includes(secret), `runner missing fail-closed ${secret}`);
  }
});

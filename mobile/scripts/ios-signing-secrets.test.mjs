import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const scripts = import.meta.dirname;
const signingNames = [
  'IOS_DISTRIBUTION_P12_BASE64',
  'IOS_DISTRIBUTION_P12_PASSWORD',
  'IOS_APP_PROFILE_BASE64',
  'IOS_SHARE_PROFILE_BASE64',
];
const binaryNames = signingNames.filter((name) => name.endsWith('_BASE64'));

// All credentials below are synthetic. No GitHub token, Apple account or native tools are used.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ios-signing-secrets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const capture = join(directory, 'gh-calls.jsonl');
  writeFileSync(capture, '');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const record = (body = null) => fs.appendFileSync(process.env.TEST_GH_CAPTURE, JSON.stringify({ args, body }) + '\\n');
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'api') {
  if (args.includes('--method')) {
    record(fs.readFileSync(0, 'utf8'));
    process.exit(0);
  }
  if (args[1].endsWith('/deployment-branch-policies')) process.stdout.write('main\\tbranch\\n');
  process.exit(0);
}
if (args[0] === 'secret' && args[1] === 'set') {
  // Match gh's actual semantics: --body is a literal, not a stdin filename.
  const index = args.indexOf('--body');
  const body = index >= 0 ? args[index + 1] : fs.readFileSync(0, 'utf8');
  record(body);
  process.exit(args[2] === process.env.TEST_FAIL_SECRET ? 51 : 0);
}
if (args[0] === 'variable' && args[1] === 'set') {
  record(args[args.indexOf('--body') + 1]);
  process.exit(0);
}
process.exit(99);
`, { mode: 0o755 });
  // Even on a developer Mac, never invoke the real security/keychain utility.
  writeFileSync(join(bin, 'security'), '#!/usr/bin/env bash\nprintf called > "$TEST_SECURITY_CALLED"\nexit 79\n', { mode: 0o755 });
  const env = {
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: directory,
    LANG: 'C',
    TEST_GH_CAPTURE: capture,
    TEST_SECURITY_CALLED: join(directory, 'security-called'),
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '101',
    GITHUB_RUN_ATTEMPT: '1',
  };
  const bytes = {
    IOS_DISTRIBUTION_P12_BASE64: Buffer.concat([Buffer.from('SYNTHETIC P12\0'), Buffer.alloc(8192, 0xff)]),
    IOS_APP_PROFILE_BASE64: Buffer.from('SYNTHETIC APP PROFILE\0\u00ff'),
    IOS_SHARE_PROFILE_BASE64: Buffer.from('SYNTHETIC SHARE PROFILE\0\u00ff'),
  };
  const password = 'fixture password: 空格 "quotes" $dollar \\slash\nsecond line';
  const files = ['distribution.p12', 'app.mobileprovision', 'share.mobileprovision'];
  binaryNames.forEach((name, index) => {
    writeFileSync(join(directory, files[index]), bytes[name]);
    env[name] = bytes[name].toString('base64');
  });
  env.IOS_DISTRIBUTION_P12_PASSWORD = password;
  const credentials = join(directory, 'credentials.json');
  writeFileSync(credentials, JSON.stringify({
    ios: {
      AgentSaaS: { distributionCertificate: { path: files[0], password }, provisioningProfilePath: files[1] },
      AgentSaaSShare: { distributionCertificate: { path: files[0], password }, provisioningProfilePath: files[2] },
    },
  }));
  const calls = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const run = (script, args = [], overrides = {}) => {
    const result = spawnSync('bash', [join(scripts, script), ...args], {
      cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(password), 'password must not appear in logs');
    for (const name of binaryNames) {
      assert.ok(!output.includes(env[name]), 'encoded credentials must not appear in logs');
      assert.ok(!output.includes(bytes[name].toString('utf8')), 'decoded credentials must not appear in logs');
    }
    return result;
  };
  const init = (args = [], overrides = {}) => run('init-ios-github-release.sh', [
    '--repo', 'example/signing-fixture', '--credentials-json', credentials, ...args,
  ], overrides);
  const native = (overrides = {}) => run('build-ios-native.sh', [
    join(directory, 'fixture.ipa'), 'a'.repeat(40), '1.101.1',
  ], overrides);
  return { directory, env, bytes, password, files, credentials, calls, init, native };
}

function assertSigningWrites(f) {
  const writes = f.calls().filter(({ args }) => args[0] === 'secret');
  assert.deepEqual(writes.slice(0, 4).map(({ args }) => args[2]), signingNames);
  for (const { args, body } of writes.slice(0, 4)) {
    assert.ok(!args.includes('--body'), 'secrets must be read from stdin, not passed in argv');
    assert.equal(args[args.indexOf('--repo') + 1], 'example/signing-fixture');
    assert.equal(args[args.indexOf('--env') + 1], 'mobile-build-production');
    assert.equal(body, f.env[args[2]]);
    assert.notEqual(body, '-');
    if (args[2].endsWith('_BASE64')) assert.deepEqual(Buffer.from(body, 'base64'), f.bytes[args[2]]);
  }
}

test('initialization writes all four exact signing credentials from stdin', (t) => {
  const f = fixture(t);
  const result = f.init(['--build-only', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assertSigningWrites(f);
  assert.equal(f.calls().filter(({ args }) => args[0] === 'secret').length, 4);
  assert.ok(!f.calls().some(({ args }) => args.includes('mobile-submit-ios-testflight')));
});

test('full initialization preserves P8 file redirection and explicit variable bodies', (t) => {
  const f = fixture(t);
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const p8 = join(f.directory, 'test-key.p8');
  writeFileSync(p8, privateKey);
  const result = f.init([
    '--api-key-p8', p8, '--api-key-id', 'TESTKEY001',
    '--issuer-id', '11111111-2222-4333-8444-555555555555', '--apply',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assertSigningWrites(f);
  const p8Write = f.calls().find(({ args }) => args[2] === 'APP_STORE_CONNECT_API_KEY_P8');
  assert.equal(p8Write.body, privateKey);
  assert.ok(!p8Write.args.includes('--body'));
  assert.ok(!(result.stdout + result.stderr).includes(privateKey));
  const variables = f.calls().filter(({ args }) => args[0] === 'variable');
  assert.deepEqual(variables.map(({ body }) => body), ['TESTKEY001', '11111111-2222-4333-8444-555555555555']);
});

test('preflight without --apply does not mutate environments or secrets', (t) => {
  const f = fixture(t);
  assert.equal(f.init(['--build-only']).status, 0);
  assert.deepEqual(f.calls(), []);
});

test('a failed secret write aborts initialization before later credentials', (t) => {
  const f = fixture(t);
  const result = f.init(['--build-only', '--apply'], { TEST_FAIL_SECRET: signingNames[1] });
  assert.equal(result.status, 51);
  assert.deepEqual(f.calls().filter(({ args }) => args[0] === 'secret').map(({ args }) => args[2]), signingNames.slice(0, 2));
  assert.ok(!result.stdout.includes('initialization completed'));
});

for (const name of binaryNames) {
  test(`native build rejects a literal dash in ${name} before accessing the keychain`, (t) => {
    const f = fixture(t);
    const result = f.native({ [name]: '-' });
    assert.equal(result.status, 3, result.stderr);
    assert.ok(result.stderr.includes(`${name}: invalid Base64 credential`));
    assert.ok(result.stderr.includes(`stage=decode-${name} failed (exit=3)`));
    assert.equal(existsSync(f.env.TEST_SECURITY_CALLED), false);
  });
}

for (const [label, value] of [
  ['whitespace', ' \t\r\n'], ['garbage', 'SENSITIVE_INVALID!'],
  ['truncated byte', 'A'], ['excess padding', 'YQ===='], ['noncanonical trailing bits', 'YR=='],
]) {
  test(`native build rejects ${label} without logging the supplied value`, (t) => {
    const f = fixture(t);
    const result = f.native({ IOS_DISTRIBUTION_P12_BASE64: value });
    assert.equal(result.status, 3, result.stderr);
    assert.ok(result.stderr.includes('IOS_DISTRIBUTION_P12_BASE64:'));
    assert.ok(result.stderr.includes('exit=3'));
    if (value.length > 4 && value.trim()) assert.ok(!result.stderr.includes(value));
    assert.equal(existsSync(f.env.TEST_SECURITY_CALLED), false);
  });
}

for (const name of signingNames) {
  test(`native build reports missing ${name} before accessing the keychain`, (t) => {
    const f = fixture(t);
    const result = f.native({ [name]: '' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`${name} is required`));
    assert.equal(existsSync(f.env.TEST_SECURITY_CALLED), false);
  });
}

for (const encoding of ['padded', 'unpadded', 'wrapped']) {
  test(`native build decodes ${encoding} Base64 with private file permissions`, (t) => {
    const f = fixture(t);
    const overrides = Object.fromEntries(binaryNames.map((name) => {
      const value = f.env[name];
      return [name, encoding === 'unpadded' ? value.replace(/=+$/, '') :
        encoding === 'wrapped' ? ` \t${value.match(/.{1,64}/g).join('\r\n')}\n` : value];
    }));
    const result = f.native(overrides);
    // Stop deliberately at the stubbed security command, before native signing.
    assert.equal(result.status, 79, result.stderr);
    assert.ok(result.stderr.includes('stage=read-provisioning-profiles failed (exit=79)'));
    assert.equal(existsSync(f.env.TEST_SECURITY_CALLED), true);
    binaryNames.forEach((name, index) => {
      const path = join(f.directory, 'ios-native-101-1', f.files[index]);
      assert.deepEqual(readFileSync(path), f.bytes[name]);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    });
  });
}

test('the iOS PR contract runs the credential regression before native dependencies', () => {
  const workflow = readFileSync(resolve(scripts, '../../.github/workflows/mobile-ios-release.yml'), 'utf8');
  const regression = workflow.indexOf('node --test mobile/scripts/ios-signing-secrets.test.mjs');
  assert.ok(regression > 0);
  assert.ok(regression < workflow.indexOf('bash mobile/scripts/setup-ios-runner.sh'));
});

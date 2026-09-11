import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Exercise the real verifier, jq, zip, shasum and OpenSSL. Only codesign/security
// use local doubles: these fixtures are NOT signed/installable IPAs. On macOS,
// plist extraction/conversion uses /usr/bin/plutil, never a plist mock.
const native = process.platform === 'darwin';
if (process.env.IOS_ARTIFACT_REQUIRE_NATIVE === '1') {
  assert.ok(native, 'The macOS CI gate must exercise the native plutil implementation');
}
const verifier = resolve(import.meta.dirname, 'verify-mobile-release-artifact.sh');
const buildNumber = '6.34560936384.1';
const sourceSha = 'a'.repeat(40);

const generatePlists = String.raw`
import base64, datetime, json, pathlib, plistlib, sys
root = pathlib.Path(sys.argv[1])
config = json.loads((root / 'config.json').read_text())
cert = (root / 'signer.der').read_bytes()
team, app, group = 'TESTTEAM01', 'com.example.fixture', 'group.com.example.fixture.share'
for label, bundle in [('main', root / 'Payload/Fixture.app'), ('share', root / 'Payload/Fixture.app/PlugIns/FixtureShare.appex')]:
    bundle.mkdir(parents=True, exist_ok=True)
    bundle_id = app if label == 'main' else app + '.share-extension'
    entitlements = {'application-identifier': team + '.' + bundle_id, 'com.apple.developer.team-identifier': team,
                    'com.apple.security.application-groups': [group], 'get-task-allow': False, 'beta-reports-active': True}
    if label == 'main':
        entitlements.update({'aps-environment': 'production', 'keychain-access-groups': [team + '.' + group]})
    signed = dict(entitlements)
    signed.update(config.get(label + 'Signed', {}))
    entitlements.update(config.get(label + 'Entitlements', {}))
    for key in config.get(label + 'RemoveSigned', []): signed.pop(key, None)
    for key in config.get(label + 'RemoveEntitlements', []): entitlements.pop(key, None)
    # Real profile-only date/data values used to break direct JSON extraction.
    profile = {'UUID': label + '-fixture', 'Name': 'Local fixture only', 'TeamIdentifier': [team],
               'ApplicationIdentifierPrefix': [team], 'Entitlements': entitlements,
               'CreationDate': datetime.datetime(2026, 1, 1), 'ExpirationDate': datetime.datetime(2099, 1, 1),
               'DeveloperCertificates': [cert, b'other synthetic certificate'], 'DER-Encoded-Profile': b'fixture-data'}
    profile.update(config.get(label + 'Profile', {}))
    if config.get(label + 'Expired'): profile['ExpirationDate'] = datetime.datetime(2000, 1, 1)
    if config.get(label + 'WrongCertificate'): profile['DeveloperCertificates'] = [b'not-the-signer']
    for key in config.get(label + 'RemoveProfile', []): profile.pop(key, None)
    if config.get(label + 'EntitlementsArray'): profile['Entitlements'] = []
    if config.get(label + 'SignedArray'): signed = []
    if config.get(label + 'EntitlementsData'): profile['Entitlements']['unsupported-data'] = b'not-json'
    info = {'CFBundleIdentifier': bundle_id, 'CFBundleShortVersionString': '1.0.0',
            'CFBundleVersion': '6.34560936384.1', 'AgentSaaSReleaseSourceGitSHA': 'a' * 40}
    info.update(config.get(label + 'Info', {}))
    fmt = plistlib.FMT_BINARY if config.get('binary') else plistlib.FMT_XML
    for name, value in [('Info.plist', info), ('embedded.mobileprovision', profile), ('signed-entitlements.plist', signed)]:
        (bundle / name).write_bytes(plistlib.dumps(value, fmt=fmt))
`;

// Linux-only behavioral double. Native CI does not execute this implementation.
const linuxPlutil = String.raw`#!/usr/bin/env -S python3 -S
import base64, datetime, json, pathlib, plistlib, sys
args = sys.argv[1:]
try:
    value = plistlib.loads(pathlib.Path(args[-1]).read_bytes())
    fmt = args[2] if args[0] == '-extract' else args[1]
    if args[0] == '-extract':
        if fmt == 'json': json.dumps(value)  # model full-profile JSON failure
        for part in args[1].split('.'):
            value = value[int(part)] if isinstance(value, list) else value[part]
    output = args[args.index('-o') + 1]
    if fmt == 'xml1': result = plistlib.dumps(value)
    elif fmt == 'json': result = json.dumps(value).encode()
    elif fmt == 'raw':
        if isinstance(value, bytes): result = base64.b64encode(value)
        elif isinstance(value, bool): result = str(value).lower().encode()
        elif isinstance(value, datetime.datetime): result = (value.isoformat() + 'Z').encode()
        elif isinstance(value, (str, int, float)): result = str(value).encode()
        else: raise ValueError('No raw representation')
    else: raise ValueError('Unexpected plutil format')
    if output == '-': sys.stdout.buffer.write(result)
    else: pathlib.Path(output).write_bytes(result)
except Exception:
    print('plutil: fixture conversion failed')
    sys.exit(1)
`;

const toolDouble = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.env.IOS_ARTIFACT_FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ tool, args }) + '\n');
if (tool === 'plutil') {
  const extract = args[0] === '-extract' && args[1] === 'Entitlements';
  const convert = args[0] === '-convert' && args[1] === 'json';
  if ((config.fault === 'extract' && extract) || (config.fault === 'convert' && convert)) {
    // Non-JSON stdout must never reach jq; neither stdout nor stderr may leak.
    console.log('PRIVATE_FIXTURE_SENTINEL: conversion failed');
    console.error('PRIVATE_FIXTURE_SENTINEL');
    process.exit(23);
  }
  if (convert && config.fault === 'invalid-json') {
    fs.writeFileSync(args[args.indexOf('-o') + 1], 'PRIVATE_FIXTURE_SENTINEL: invalid JSON');
    process.exit(0);
  }
  const command = process.platform === 'darwin' ? '/usr/bin/plutil' : path.join(root, 'linux-plutil');
  const result = cp.spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
if (tool === 'security') {
  if (args.join(' ').includes('cms -D -i')) {
    process.stdout.write(fs.readFileSync(args.at(-1)));
    process.exit(0);
  }
} else if (tool === 'codesign') {
  const bundle = args.at(-1);
  const label = bundle.endsWith('.appex') ? 'share' : 'main';
  if (args.includes('--verify')) process.exit(config.rejectSignature === label ? 1 : 0);
  if (args.includes('--entitlements')) {
    process.stdout.write(fs.readFileSync(path.join(bundle, 'signed-entitlements.plist')));
    process.exit(0);
  }
  const prefix = args.find((arg) => arg.startsWith('--extract-certificates='));
  if (prefix) {
    fs.copyFileSync(path.join(root, 'signer.der'), prefix.split('=')[1] + '0');
    process.exit(0);
  }
}
throw new Error('Unexpected fixture tool invocation: ' + tool);
`;

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ios artifact-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
  writeFileSync(join(directory, 'linux-plutil'), linuxPlutil, { mode: 0o700 });
  for (const tool of ['plutil', 'codesign', 'security']) {
    writeFileSync(join(bin, tool), toolDouble, { mode: 0o700 });
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-subj', '/CN=Local Artifact Fixture', '-days', '1', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'signer.pem')], { stdio: 'pipe' });
  execFileSync('openssl', ['x509', '-in', join(directory, 'signer.pem'), '-outform', 'DER',
    '-out', join(directory, 'signer.der')]);
  execFileSync('python3', ['-S', '-c', generatePlists, directory]);
  const artifact = join(directory, 'Fixture.ipa');
  execFileSync('zip', ['-qr', artifact, 'Payload'], { cwd: directory });
  const source = join(directory, 'source.json');
  writeFileSync(source, JSON.stringify({ profile: 'ios-store', appId: 'com.example.fixture',
    version: '1.0.0', buildNumber, sourceGitSha: sourceSha, iosTeamId: 'TESTTEAM01',
    iosAppGroup: 'group.com.example.fixture.share', versionCode: null }));
  const output = join(directory, 'verification.json');
  function run(destination = output) {
    return spawnSync('bash', [verifier, 'ios-store', artifact, source, destination], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IOS_ARTIFACT_FIXTURE: directory },
      encoding: 'utf8', timeout: 60_000,
    });
  }
  return { directory, artifact, output, run };
}

for (const binary of [false, true]) {
  test(`complete IPA verification and deterministic replay (${binary ? 'binary' : 'XML'} plist)`, (t) => {
    t.diagnostic(`plist backend: ${native ? '/usr/bin/plutil (native)' : 'Linux behavioral double'}`);
    const item = fixture(t, { binary });
    const result = item.run();
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    const original = readFileSync(item.output, 'utf8');
    const record = JSON.parse(original);
    assert.equal(record.buildNumber, buildNumber);
    assert.equal(record.appId, 'com.example.fixture');
    assert.equal(record.versionCode, null);
    assert.match(record.signerFingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.match(record.permissionsSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(record.size, statSync(item.artifact).size);
    assert.equal(record.artifactSha256, `sha256:${createHash('sha256').update(readFileSync(item.artifact)).digest('hex')}`);
    if (native) {
      const legacy = spawnSync('/usr/bin/plutil', ['-extract', 'Entitlements', 'json', '-o', '-',
        join(item.directory, 'Payload/Fixture.app/embedded.mobileprovision')], { encoding: 'utf8' });
      t.diagnostic(`legacy direct Entitlements JSON extraction exit=${legacy.status}; two-step verification exit=${result.status}`);
    }
    assert.equal(statSync(item.output).mode & 0o777, 0o600);
    const replay = join(item.directory, 'replay.json');
    assert.equal(item.run(replay).status, 0);
    assert.equal(readFileSync(replay, 'utf8'), original, 'build and submission must produce identical verification records');
    const calls = readFileSync(join(item.directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(({ tool, args }) => tool === 'codesign' && args.includes('--deep')));
    assert.ok(calls.some(({ tool, args }) => tool === 'codesign' && args.includes('--verify') && args.at(-1).endsWith('.appex')));
    assert.equal(calls.filter(({ tool, args }) => tool === 'plutil' && args[0] === '-extract' && args[1] === 'Entitlements').length, 4);
    assert.ok(calls.filter(({ tool, args }) => tool === 'plutil' && args[1] === 'Entitlements').every(({ args }) => args[2] === 'xml1'));
  });
}

for (const [name, config, diagnostic] of [
  ['profile extraction failure', { fault: 'extract' }, /main-app: provisioning profile Entitlements extraction failed/u],
  ['plist conversion failure', { fault: 'convert' }, /main-app-profile: entitlements plist-to-JSON conversion failed/u],
  ['invalid conversion output', { fault: 'invalid-json' }, /main-app-profile: expected one valid entitlements JSON object/u],
  ['non-JSON data inside entitlements', { mainEntitlementsData: true }, /main-app-profile: entitlements plist-to-JSON conversion failed/u],
  ['missing profile entitlements', { mainRemoveProfile: ['Entitlements'] }, /Entitlements extraction failed/u],
  ['profile array instead of dictionary', { mainEntitlementsArray: true }, /expected one valid entitlements JSON object/u],
  ['signed array instead of dictionary', { mainSignedArray: true }, /main-app-signed: expected one valid entitlements JSON object/u],
  ['Share Extension array', { shareEntitlementsArray: true }, /share-extension-profile: expected one valid entitlements JSON object/u],
]) {
  test(`conversion fails closed: ${name}`, (t) => {
    const item = fixture(t, config);
    const result = item.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_FIXTURE_SENTINEL|jq: parse error/u);
    assert.equal(existsSync(item.output), false, 'failed verification must not publish a record');
  });
}

for (const [name, config, diagnostic] of [
  ['main signature', { rejectSignature: 'main' }, /stage=verify-main-app/u],
  ['extension signature', { rejectSignature: 'share' }, /stage=verify-share-extension/u],
  ['source SHA', { mainInfo: { AgentSaaSReleaseSourceGitSHA: 'b'.repeat(40) } }, /signed source Git SHA mismatch/u],
  ['extension build number', { shareInfo: { CFBundleVersion: '6.1.1' } }, /Share Extension build number mismatch/u],
  ['profile Team ID', { mainProfile: { TeamIdentifier: ['WRONGTEAM1'] } }, /Apple Team mismatch/u],
  ['signed application ID', { mainSigned: { 'application-identifier': 'TESTTEAM01.wrong' } }, /signed application identifier mismatch/u],
  ['main development entitlement', { mainSigned: { 'get-task-allow': true } }, /development entitlement rejected/u],
  ['extension development entitlement', { shareSigned: { 'get-task-allow': true } }, /signed development entitlement rejected/u],
  ['ad-hoc profile with device array', { mainProfile: { ProvisionedDevices: ['fixture-device'] } }, /not App Store distribution/u],
  ['enterprise profile', { mainProfile: { ProvisionsAllDevices: true } }, /not App Store distribution/u],
  ['expired profile', { mainExpired: true }, /expired or invalid/u],
  ['main APNs sandbox', { mainSigned: { 'aps-environment': 'development' } }, /signed APNs environment must be production/u],
  ['profile APNs sandbox', { mainEntitlements: { 'aps-environment': 'development' } }, /profile APNs environment must be production/u],
  ['unexpected extension APNs', { shareEntitlements: { 'aps-environment': 'production' } }, /unexpected push entitlement/u],
  ['profile App Group', { mainEntitlements: { 'com.apple.security.application-groups': ['wrong'] } }, /profile App Group mismatch/u],
  ['signed App Group', { mainSigned: { 'com.apple.security.application-groups': ['wrong'] } }, /signed App Group entitlement mismatch/u],
  ['signed Keychain Group', { mainSigned: { 'keychain-access-groups': ['wrong'] } }, /signed Keychain Group entitlement mismatch/u],
  ['main certificate membership', { mainWrongCertificate: true }, /signer is absent/u],
  ['extension certificate membership', { shareWrongCertificate: true }, /signer is absent/u],
]) {
  test(`security gate remains enforced: ${name}`, (t) => {
    const item = fixture(t, config);
    const result = item.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assert.equal(existsSync(item.output), false);
  });
}

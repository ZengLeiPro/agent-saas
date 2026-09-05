import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CONFIG_DIGEST,
  DEPENDENCY_DIGEST,
  OTHER_CONFIG_DIGEST,
  SERVER_DIGEST,
  SHA,
  harness,
  observedStdout,
  onlyReceipt,
  releaseCli,
  tick,
  trackTemp,
} from './__tests__/launcherHarness.js';
import {
  EXIT_RECEIPT_FAILED,
  EXIT_REJECTED,
  LAUNCH_NONCE_ENV,
  RECEIPT_DIR_ENV,
  isInsideDirectory,
  parseLauncherArgv,
  realpathOfNearestExisting,
  resolveConfigPath,
  runAdminLauncher,
} from './launcher.js';

describe('parseLauncherArgv', () => {
  it('separates launcher options from script arguments', () => {
    expect(
      parseLauncherArgv([
        'demo',
        '--authorization-ref',
        'CHG-1',
        '--runtime-data-dir',
        '/data',
        '--',
        '--execute',
        '--x=1',
      ]),
    ).toEqual({
      command: 'demo',
      authorizationRef: 'CHG-1',
      runtimeDataDir: '/data',
      scriptArgs: ['--execute', '--x=1'],
    });
    expect(parseLauncherArgv(['demo', '--authorization-ref=CHG-2'])).toEqual({
      command: 'demo',
      authorizationRef: 'CHG-2',
      scriptArgs: [],
    });
    expect(parseLauncherArgv(['demo'])).toEqual({ command: 'demo', scriptArgs: [] });
  });

  it('rejects malformed input with fixed messages that never echo the input', () => {
    const cases: Array<[string[], RegExp]> = [
      [[], /usage/u],
      [['--execute'], /usage/u],
      [['/etc/private/customer'], /invalid shape/u],
      [['demo', '--tenant-customer-123'], /unknown launcher option/u],
      [['demo', '--authorization-ref'], /missing its value/u],
      [['demo', '--authorization-ref', '--'], /missing its value/u],
      [['demo', '--authorization-ref', 'a', '--authorization-ref', 'b'], /given twice/u],
    ];
    for (const [argv, pattern] of cases) {
      let message = '';
      try {
        parseLauncherArgv(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, argv.join(' ')).toMatch(pattern);
      expect(message).not.toContain('customer');
      expect(message).not.toContain('/etc/');
    }
  });
});

describe('path helpers', () => {
  it('isInsideDirectory treats the directory itself and descendants as inside', () => {
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel/server')).toBe(true);
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel/server/receipts')).toBe(true);
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel/server-receipts')).toBe(false);
    expect(isInsideDirectory('/opt/rel/server', '/opt/rel')).toBe(false);
    expect(isInsideDirectory('/opt/rel/server', '/var/lib/receipts')).toBe(false);
  });

  it('resolveConfigPath mirrors getAppConfigPath without trimming', () => {
    expect(
      resolveConfigPath({ AGENT_SAAS_CONFIG_PATH: '/etc/a.json' }, '/rel/server', '/cwd'),
    ).toBe('/etc/a.json');
    expect(resolveConfigPath({ AGENT_SAAS_CONFIG_PATH: './a.json' }, '/rel/server', '/cwd')).toBe(
      '/cwd/a.json',
    );
    expect(resolveConfigPath({ CONFIG_JSON_PATH: 'b.json' }, '/rel/server', '/cwd')).toBe(
      '/cwd/b.json',
    );
    expect(
      resolveConfigPath(
        { AGENT_SAAS_CONFIG_PATH: ' ', CONFIG_JSON_PATH: 'b.json' },
        '/rel/server',
        '/cwd',
      ),
    ).toBe('/cwd/ ');
    expect(resolveConfigPath({}, '/rel/server', '/cwd')).toBe('/rel/config.json');
  });

  it('realpathOfNearestExisting resolves through the nearest existing ancestor', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'admin-realpath-')));
    trackTemp(root);
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'));
    expect(await realpathOfNearestExisting(join(root, 'link', 'a', 'b'), realpath)).toBe(
      join(root, 'real', 'a', 'b'),
    );
    expect(await realpathOfNearestExisting(join(root, 'real'), realpath)).toBe(join(root, 'real'));
  });
});

describe('runAdminLauncher', () => {
  it('refuses without a receipt directory and writes nothing', async () => {
    const h = await harness({ env: { [RECEIPT_DIR_ENV]: undefined } });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.spawnCalls).toEqual([]);
    expect(h.stderr[0]).toMatch(/receipt_dir_unavailable/u);
  });

  it('refuses a receipt directory inside the sealed release tree, including via symlink', async () => {
    const h = await harness();
    h.deps.env[RECEIPT_DIR_ENV] = join(h.releaseRoot, 'receipts');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.stderr[0]).toMatch(/must not be inside the sealed release directory/u);
    await expect(stat(join(h.releaseRoot, 'receipts'))).rejects.toThrow();
    // 相对路径同样按 launcher cwd 解析后判定。
    h.stderr.length = 0;
    h.deps.cwd = h.releaseRoot;
    h.deps.env[RECEIPT_DIR_ENV] = 'dist/receipts';
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.stderr[0]).toMatch(/must not be inside/u);
    // 外部路径是指向 release 内目录的符号链接：按 realpath 拒绝。
    h.stderr.length = 0;
    h.deps.cwd = h.root;
    const link = join(h.root, 'receipts-link');
    await symlink(join(h.releaseRoot, 'dist'), link);
    h.deps.env[RECEIPT_DIR_ENV] = join(link, 'nested', 'deeper');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.stderr[0]).toMatch(/must not be inside/u);
    await expect(stat(join(h.releaseRoot, 'dist', 'nested'))).rejects.toThrow();
  });

  it('refuses when a receipt subdirectory symlink points back into the release tree', async () => {
    const h = await harness();
    await symlink(join(h.releaseRoot, 'dist'), join(h.receiptDir, 'production'));
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_RECEIPT_FAILED);
    expect(h.stderr.at(-1)).toMatch(/receipt write failed .*sealed release directory/u);
    expect(h.spawnCalls).toEqual([]);
    await expect(stat(join(h.releaseRoot, 'dist', '20260905'))).rejects.toThrow();
  });

  it('resolves a relative receipt directory against cwd and forwards the absolute path', async () => {
    const h = await harness();
    h.deps.env[RECEIPT_DIR_ENV] = relative(h.root, h.receiptDir);
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(0);
    expect(h.spawnCalls[0]!.options.env[RECEIPT_DIR_ENV]).toBe(h.receiptDir);
    expect(h.spawnCalls[0]!.markerExisted).toBe(true);
    expect((await onlyReceipt(h.receiptDir)).result).toBe('succeeded');
  });

  it('rejects unknown and malformed commands without copying them into the receipt', async () => {
    const h = await harness();
    expect(await runAdminLauncher(['nope'], h.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(h.receiptDir, 'unidentified')).toMatchObject({
      result: 'rejected',
      errorCategory: 'unknown_command',
      command: 'nope',
    });
    expect(h.spawnCalls).toEqual([]);
    const malformed = await harness();
    expect(await runAdminLauncher(['/etc/private/customer', '--x'], malformed.deps)).toBe(
      EXIT_REJECTED,
    );
    const receipt = await onlyReceipt(malformed.receiptDir, 'unidentified');
    expect(receipt).toMatchObject({ errorCategory: 'invalid_arguments', command: '(invalid)' });
    expect(JSON.stringify(receipt)).not.toContain('customer');
    const unknownOption = await harness();
    expect(await runAdminLauncher(['demo', '--tenant-customer-123'], unknownOption.deps)).toBe(
      EXIT_REJECTED,
    );
    expect(
      JSON.stringify(await onlyReceipt(unknownOption.receiptDir, 'unidentified')),
    ).not.toContain('customer');
  });

  it('rejects tampered entries before touching identities', async () => {
    const h = await harness({ tamperEntry: true });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(h.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'entry_tampered',
    });
    expect(h.cliCalls).toEqual([]);
  });

  it('runs a dry-run through the entry with nonce, marker and the same absolute config path', async () => {
    const h = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--runtime-data-dir', '/mnt/data', '--', '--limit', '5'],
        h.deps,
      ),
    ).toBe(0);
    expect(h.spawnCalls).toHaveLength(1);
    const call = h.spawnCalls[0]!;
    expect(call.file).toBe('/fake/node');
    expect(call.args).toEqual([join(h.adminDir, 'demo.mjs'), '--limit', '5']);
    expect(call.options.cwd).toBe(h.releaseRoot);
    expect(call.options.env[LAUNCH_NONCE_ENV]).toBe('a'.repeat(32));
    expect(call.options.env.AGENT_SAAS_CONFIG_PATH).toBe('/etc/agent-saas/config.json');
    expect(call.markerExisted).toBe(true);
    await expect(stat(join(h.receiptDir, '.launch', `${'a'.repeat(32)}.json`))).rejects.toThrow();
    expect(h.cliCalls[0]).toEqual(
      expect.arrayContaining([
        '--config',
        '/etc/agent-saas/config.json',
        '--environment',
        'production',
        '--process-cwd',
        h.releaseRoot,
        '--runtime-data-dir',
        '/mnt/data',
      ]),
    );
    const receipt = await onlyReceipt(h.receiptDir);
    expect(receipt).toMatchObject({
      result: 'succeeded',
      exitCode: 0,
      mode: 'dry_run',
      defaultMode: 'dry_run',
      riskLevel: 'high',
      environment: 'production',
      writeIntents: [],
      targetOverrides: [],
      authorizationForwarded: false,
      release: {
        status: 'bound',
        releaseId: 'rel-20260905',
        releaseSha: SHA,
        serverDigest: SERVER_DIGEST,
      },
      configIdentity: {
        status: 'consistent',
        gate: 'passed',
        expectedDigest: CONFIG_DIGEST,
        observedDigest: CONFIG_DIGEST,
      },
      actor: { source: 'process_env', user: 'ops', trusted: false },
      argsSummary: {
        declaredFlags: [],
        otherFlagCount: 1,
        positionalCount: 1,
        inlineValueCount: 0,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('a'.repeat(32));
    expect(JSON.stringify(receipt)).not.toContain('/mnt/data');
    expect(h.signalListeners.size).toBe(0);
  });

  it('resolves a relative config path against the launcher cwd for both preflight and child', async () => {
    const h = await harness({ env: { AGENT_SAAS_CONFIG_PATH: './cfg/config.json' } });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(0);
    const expected = join(h.root, 'cfg', 'config.json');
    expect(h.cliCalls[0]).toEqual(expect.arrayContaining(['--config', expected]));
    expect(h.spawnCalls[0]!.options.env.AGENT_SAAS_CONFIG_PATH).toBe(expected);
    const fallback = await harness({ env: { AGENT_SAAS_CONFIG_PATH: undefined } });
    expect(await runAdminLauncher(['demo'], fallback.deps)).toBe(0);
    expect(fallback.cliCalls[0]).toEqual(
      expect.arrayContaining(['--config', join(fallback.releaseRoot, '..', 'config.json')]),
    );
  });

  it('records target override signals by name and never their values', async () => {
    const h = await harness({ env: { DATABASE_URL: 'postgres://u:pw@other/db' } });
    expect(
      await runAdminLauncher(['demo', '--', '--connection-string', 'postgres://u:pw@x/y'], h.deps),
    ).toBe(0);
    const receipt = await onlyReceipt(h.receiptDir);
    expect(receipt.targetOverrides).toEqual(['--connection-string', 'env:DATABASE_URL']);
    expect(JSON.stringify(receipt)).not.toContain('postgres://');
  });

  it('refuses write intents without an authorization ref and never spawns', async () => {
    const h = await harness();
    expect(await runAdminLauncher(['demo', '--', '--execute'], h.deps)).toBe(EXIT_REJECTED);
    expect(h.spawnCalls).toEqual([]);
    expect(await onlyReceipt(h.receiptDir, 'unidentified')).toMatchObject({
      result: 'rejected',
      errorCategory: 'write_flag_without_authorization',
      mode: 'write',
      writeIntents: ['--execute'],
    });
  });

  it('does not treat --execute=value as a write intent, matching the scripts', async () => {
    const h = await harness();
    expect(await runAdminLauncher(['demo', '--', '--execute=false'], h.deps)).toBe(0);
    expect(await onlyReceipt(h.receiptDir)).toMatchObject({
      mode: 'dry_run',
      writeIntents: [],
      argsSummary: {
        declaredFlags: [],
        otherFlagCount: 1,
        positionalCount: 0,
        inlineValueCount: 1,
      },
    });
  });

  it('enforces required flags before any identity work', async () => {
    const missing = await harness();
    expect(await runAdminLauncher(['needs-output'], missing.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(missing.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'invalid_arguments',
      errorDetail: 'required flag missing: --output',
    });
    expect(missing.cliCalls).toEqual([]);
    const provided = await harness();
    expect(await runAdminLauncher(['needs-output', '--', '--output=/tmp/out'], provided.deps)).toBe(
      0,
    );
    const receipt = await onlyReceipt(provided.receiptDir);
    expect(receipt.result).toBe('succeeded');
    expect(JSON.stringify(receipt)).not.toContain('/tmp/out');
  });

  it('holds the authorization ref for scripts that do not accept it and forwards it to those that do', async () => {
    const held = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--authorization-ref', 'CHG-7', '--', '--execute', '--force'],
        held.deps,
      ),
    ).toBe(0);
    expect(held.spawnCalls[0]!.args).toEqual([
      join(held.adminDir, 'demo.mjs'),
      '--execute',
      '--force',
    ]);
    expect(await onlyReceipt(held.receiptDir)).toMatchObject({
      mode: 'write',
      writeIntents: ['--execute'],
      escalationFlags: ['--force'],
      authorizationRef: 'CHG-7',
      authorizationForwarded: false,
      argsSummary: {
        declaredFlags: ['--execute', '--force'],
        otherFlagCount: 0,
        positionalCount: 0,
        inlineValueCount: 0,
      },
    });
    const forwarded = await harness();
    expect(
      await runAdminLauncher(
        ['ref-cmd', '--authorization-ref', 'CHG-8', '--', '--execute-retention'],
        forwarded.deps,
      ),
    ).toBe(0);
    expect(forwarded.spawnCalls[0]!.args).toEqual([
      join(forwarded.adminDir, 'ref-cmd.mjs'),
      '--execute-retention',
      '--authorization-ref',
      'CHG-8',
    ]);
    expect(await onlyReceipt(forwarded.receiptDir)).toMatchObject({
      authorizationForwarded: true,
      mode: 'write',
    });
  });

  it('rejects escalation flags without their write intent, misplaced, malformed and token-shaped refs', async () => {
    const escalation = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--authorization-ref', 'CHG-1', '--', '--force'],
        escalation.deps,
      ),
    ).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(escalation.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'escalation_without_write',
    });
    const misplaced = await harness();
    expect(
      await runAdminLauncher(
        ['demo', '--', '--execute', '--authorization-ref', 'CHG-1'],
        misplaced.deps,
      ),
    ).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(misplaced.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'authorization_ref_misplaced',
    });
    for (const bad of ['postgres://db/app', 'ghp_abcdefghijklmnopqrstuvwxyz', 'CHG/home/1']) {
      const malformed = await harness();
      expect(
        await runAdminLauncher(
          ['demo', '--authorization-ref', bad, '--', '--execute'],
          malformed.deps,
        ),
        bad,
      ).toBe(EXIT_REJECTED);
      const receipt = await onlyReceipt(malformed.receiptDir, 'unidentified');
      expect(receipt.errorCategory).toBe('authorization_ref_invalid');
      expect(JSON.stringify(receipt)).not.toContain(bad);
    }
  });

  it('rejects unidentified and unsupported environments', async () => {
    const unidentified = await harness({ env: { AGENT_SAAS_ENVIRONMENT: undefined } });
    expect(await runAdminLauncher(['demo'], unidentified.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(unidentified.receiptDir, 'unidentified')).toMatchObject({
      errorCategory: 'environment_unidentified',
    });
    const unsupported = await harness();
    expect(await runAdminLauncher(['staging-only'], unsupported.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(unsupported.receiptDir)).toMatchObject({
      errorCategory: 'environment_unsupported',
      environment: 'production',
    });
  });

  it('rejects release identity that is missing or mismatched in production', async () => {
    const missing = await harness({ omitRuntimeDependencies: true });
    expect(await runAdminLauncher(['demo'], missing.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(missing.receiptDir)).toMatchObject({
      errorCategory: 'release_identity_mismatch',
      release: { status: 'mismatch', reason: 'runtime_dependencies_missing' },
    });
    const mismatch = await harness({ runtimeSha: '0'.repeat(40) });
    expect(await runAdminLauncher(['demo'], mismatch.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(mismatch.receiptDir)).toMatchObject({
      release: { reason: 'release_sha_mismatch' },
    });
    const notBound = await harness({ env: { AGENT_SAAS_RELEASE_SHA: undefined } });
    expect(await runAdminLauncher(['demo'], notBound.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(notBound.receiptDir)).toMatchObject({
      errorCategory: 'release_identity_missing',
      release: { status: 'not_bound' },
    });
    expect(missing.cliCalls).toEqual([]);
  });
});

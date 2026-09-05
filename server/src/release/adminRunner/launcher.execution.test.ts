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

describe('runAdminLauncher (execution and receipts)', () => {
  it('applies the config identity matrix in production', async () => {
    const drifted = await harness({
      cli: { code: 0, stdout: observedStdout(OTHER_CONFIG_DIGEST) },
    });
    expect(await runAdminLauncher(['demo'], drifted.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(drifted.receiptDir)).toMatchObject({
      errorCategory: 'config_identity_drifted',
      configIdentity: { status: 'drifted', gate: 'rejected' },
    });
    expect(drifted.spawnCalls).toEqual([]);

    const unboundEnv = {
      AGENT_SAAS_CONFIG_IDENTITY_DIGEST: undefined,
      AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: undefined,
    };
    const unboundDryRun = await harness({ env: unboundEnv });
    expect(await runAdminLauncher(['demo'], unboundDryRun.deps)).toBe(0);
    expect(await onlyReceipt(unboundDryRun.receiptDir)).toMatchObject({
      result: 'succeeded',
      configIdentity: { status: 'unverifiable', reason: 'expected_not_bound', gate: 'annotated' },
    });
    const unboundWrite = await harness({ env: unboundEnv });
    expect(
      await runAdminLauncher(
        ['demo', '--authorization-ref', 'CHG-1', '--', '--execute'],
        unboundWrite.deps,
      ),
    ).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(unboundWrite.receiptDir)).toMatchObject({
      errorCategory: 'config_identity_unverifiable',
    });
    expect(unboundWrite.spawnCalls).toEqual([]);

    const cliFailed = await harness({
      cli: { code: 1, stdout: '', stderr: 'config-identity-cli failed: vault unreachable' },
    });
    expect(await runAdminLauncher(['demo'], cliFailed.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(cliFailed.receiptDir)).toMatchObject({
      errorCategory: 'config_identity_unverifiable',
      configIdentity: { reason: 'observation_failed' },
    });
    expect(
      cliFailed.stderr.some((line) =>
        line.includes('[config-identity-cli] config-identity-cli failed'),
      ),
    ).toBe(true);
    expect(JSON.stringify(await onlyReceipt(cliFailed.receiptDir))).not.toContain(
      'vault unreachable',
    );
    const cliThrew = await harness({ cli: new Error('spawn ENOENT') });
    expect(await runAdminLauncher(['demo'], cliThrew.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(cliThrew.receiptDir)).toMatchObject({
      configIdentity: { reason: 'observation_failed' },
    });
  });

  it('lets development run with annotations while still rejecting mismatches', async () => {
    const devEnv = {
      AGENT_SAAS_ENVIRONMENT: undefined,
      NODE_ENV: 'development',
      AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT: '1',
      AGENT_SAAS_RELEASE_SHA: undefined,
      AGENT_SAAS_CONFIG_IDENTITY_DIGEST: undefined,
      AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: undefined,
    };
    const dev = await harness({
      env: devEnv,
      cli: { code: 0, stdout: observedStdout(OTHER_CONFIG_DIGEST) },
    });
    expect(
      await runAdminLauncher(['demo', '--authorization-ref', 'DEV-1', '--', '--execute'], dev.deps),
    ).toBe(0);
    expect(await onlyReceipt(dev.receiptDir, 'development')).toMatchObject({
      result: 'succeeded',
      environment: 'development',
      release: { status: 'not_bound' },
      configIdentity: { status: 'unverifiable', reason: 'expected_not_bound', gate: 'annotated' },
    });
    const devMismatch = await harness({ env: devEnv });
    await writeFile(
      join(devMismatch.releaseRoot, 'runtime-dependencies.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'agent-saas-runtime-dependency-identity',
        sourceSha: SHA,
        contractDigest: `sha256:${'8'.repeat(64)}`,
        dependencyDigest: DEPENDENCY_DIGEST,
      }),
    );
    expect(await runAdminLauncher(['demo'], devMismatch.deps)).toBe(EXIT_REJECTED);
    expect(await onlyReceipt(devMismatch.receiptDir, 'development')).toMatchObject({
      errorCategory: 'release_identity_mismatch',
    });
  });

  it('records script failures with their exit code without pretending success', async () => {
    const h = await harness({ childExitCode: 2 });
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(2);
    expect(await onlyReceipt(h.receiptDir)).toMatchObject({
      result: 'failed',
      exitCode: 2,
      errorCategory: 'script_exit_nonzero',
    });
    const spawnFailed = await harness({ spawnThrows: true });
    expect(await runAdminLauncher(['demo'], spawnFailed.deps)).toBe(1);
    expect(await onlyReceipt(spawnFailed.receiptDir)).toMatchObject({
      result: 'failed',
      errorCategory: 'script_spawn_failed',
    });
    await expect(
      stat(join(spawnFailed.receiptDir, '.launch', `${'a'.repeat(32)}.json`)),
    ).rejects.toThrow();
  });

  it('forwards SIGINT to the child, keeps handlers until the receipt is written, then releases them', async () => {
    const h = await harness({ hang: true });
    const pending = runAdminLauncher(['demo'], h.deps);
    await tick();
    expect(h.signalListeners.has('SIGINT')).toBe(true);
    h.signalListeners.get('SIGINT')!();
    expect(await pending).toBe(130);
    expect(h.child.killedWith).toBe('SIGINT');
    expect(await onlyReceipt(h.receiptDir)).toMatchObject({
      result: 'cancelled',
      signal: 'SIGINT',
      errorCategory: 'script_signal',
    });
    expect(h.signalListeners.size).toBe(0);
  });

  it('cancels during preflight with a terminal receipt, even when the pending gate would reject', async () => {
    const cleanCancel = await harness({ cliHang: true });
    const pending = runAdminLauncher(['demo'], cleanCancel.deps);
    await tick();
    expect(cleanCancel.cliCalls).toHaveLength(1);
    cleanCancel.signalListeners.get('SIGTERM')!();
    releaseCli();
    expect(await pending).toBe(143);
    expect(cleanCancel.spawnCalls).toEqual([]);
    expect(await onlyReceipt(cleanCancel.receiptDir)).toMatchObject({
      result: 'cancelled',
      signal: 'SIGTERM',
      errorCategory: 'script_signal',
    });
    await expect(
      stat(join(cleanCancel.receiptDir, '.launch', `${'a'.repeat(32)}.json`)),
    ).rejects.toThrow();

    // 取消优先于拒绝：观察期间收到信号，随后 CLI 返回 drifted，仍记 cancelled/143。
    const wouldReject = await harness({
      cliHang: true,
      cli: { code: 0, stdout: observedStdout(OTHER_CONFIG_DIGEST) },
    });
    const pendingReject = runAdminLauncher(['demo'], wouldReject.deps);
    await tick();
    wouldReject.signalListeners.get('SIGTERM')!();
    releaseCli();
    expect(await pendingReject).toBe(143);
    expect(await onlyReceipt(wouldReject.receiptDir)).toMatchObject({
      result: 'cancelled',
      signal: 'SIGTERM',
      errorCategory: 'script_signal',
    });
  });

  it('writes a started receipt before execution and never leaks values or paths', async () => {
    const h = await harness({ hang: true });
    const pending = runAdminLauncher(
      [
        'demo',
        '--authorization-ref',
        'CHG-9',
        '--runtime-data-dir',
        '/mnt/agent-saas/server-data',
        '--',
        '--execute',
        '--connection-string',
        'postgres://user:pw@db/app',
        '--root=/etc/agent-saas/secret',
        '--tenant-customer-123',
      ],
      h.deps,
    );
    await tick();
    const started = await onlyReceipt(h.receiptDir);
    expect(started.result).toBe('started');
    h.child.emit('exit', 0, null);
    expect(await pending).toBe(0);
    const final = await onlyReceipt(h.receiptDir);
    const json = JSON.stringify(final);
    expect(final.result).toBe('succeeded');
    expect(final.invocationId).toBe(started.invocationId);
    for (const leak of [
      'postgres://',
      'user:pw',
      '/etc/agent-saas',
      '/mnt/agent-saas',
      'customer-123',
      h.root,
    ]) {
      expect(json).not.toContain(leak);
    }
    expect(final.argsSummary).toEqual({
      declaredFlags: ['--execute'],
      otherFlagCount: 3,
      positionalCount: 1,
      inlineValueCount: 1,
    });
    expect(final.targetOverrides).toEqual(['--connection-string', '--root']);
  });

  it('exits 4 when the receipt cannot be written', async () => {
    const h = await harness();
    await rm(h.receiptDir, { recursive: true, force: true });
    await writeFile(h.receiptDir, 'not a directory');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_RECEIPT_FAILED);
    expect(h.spawnCalls).toEqual([]);
    expect(h.stderr.at(-1)).toMatch(/receipt write failed/u);
    expect(h.signalListeners.size).toBe(0);
  });

  it('still writes a terminal receipt when the launch marker cannot be created', async () => {
    const h = await harness();
    await writeFile(join(h.receiptDir, '.launch'), 'not a directory');
    expect(await runAdminLauncher(['demo'], h.deps)).toBe(EXIT_REJECTED);
    const receipt = await onlyReceipt(h.receiptDir);
    expect(receipt).toMatchObject({ result: 'rejected', errorCategory: 'receipt_dir_unavailable' });
    expect(JSON.stringify(receipt)).not.toContain(h.root);
    expect(h.spawnCalls).toEqual([]);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig, type AppConfig } from '../app/config.js';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { capabilityConfigFingerprint } from '../config/capabilityContract.js';
import {
  CapabilityEnableError,
  SecretStagingArea,
  capabilityEnableHttpStatus,
  runCapabilityEnableTransaction,
  type CapabilityEnableTransactionOptions,
} from '../config/capabilityEnableTransaction.js';
import { CapabilityValidationJournal } from '../config/capabilityValidationJournal.js';
import { configFingerprint } from '../config/configDigest.js';
import { InMemorySecretVault, type VaultCaller } from '../security/secretVault.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const CALLER: VaultCaller = {
  actor: 'system',
  userId: 'tool_controls_admin',
  scopes: ['secret:web_tools:write', 'secret:web_tools:revoke'],
};

/** 运行时按 `__system__` 主体读取凭据；管理端主体只负责写入与撤销。 */
const READER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:web_tools:read'],
};

const BASE_RAW = {
  agent: { cwd: '/tmp/workspace', maxTurns: 20, permissionMode: 'default' },
  server: { port: 3000 },
  webTools: { enabled: false },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'capability-enable-'));
  roots.push(root);
  await mkdir(join(root, 'data'));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, `${JSON.stringify(BASE_RAW, null, 2)}\n`, { mode: 0o640 });

  const vault = new InMemorySecretVault();
  const effective: { config: AppConfig } = { config: parseAppConfig(BASE_RAW) };
  const stagedRefs: string[] = [];
  const journal = new CapabilityValidationJournal({
    processCwd: root,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
  });

  const options = (
    overrides: Partial<CapabilityEnableTransactionOptions> = {},
  ): CapabilityEnableTransactionOptions => ({
    capability: 'webTools',
    actor: 'admin-1',
    changedPaths: ['webTools'],
    mutationService: new AdminConfigMutationService({
      configPath,
      processCwd: root,
      environment: 'staging',
      processRole: 'ws-only',
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    }),
    journal,
    staging: new SecretStagingArea(vault, CALLER),
    getEffectiveConfig: () => effective.config,
    prepare: async (staging) => {
      stagedRefs.push(
        await staging.stage('web_tools', 'brave-live-key', { purpose: 'web-search' }),
      );
    },
    validateCandidate: () => undefined,
    probe: () => undefined,
    buildCandidate: (text) =>
      applyEdits(
        text,
        modify(
          text,
          ['webTools'],
          { enabled: true, search: { provider: 'brave', apiKeyRef: 'ref' } },
          {},
        ),
      ),
    applyRuntime: (next) => {
      effective.config = next;
    },
    readEffectiveFingerprints: async (next) => [
      { source: 'api:ws-only', fingerprint: configFingerprint(next) },
    ],
    convergence: { attempts: 1, delayMs: 0 },
    ...overrides,
  });

  const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
  return { root, configPath, vault, journal, effective, options, readConfig, stagedRefs };
}

async function expectEnableError(
  promise: Promise<unknown>,
  code: string,
): Promise<CapabilityEnableError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(CapabilityEnableError);
  expect((error as CapabilityEnableError).code).toBe(code);
  return error as CapabilityEnableError;
}

describe('capability enable transaction', () => {
  it('探测通过后原子写入并记录通过的验证', async () => {
    const test = await fixture();
    const result = await runCapabilityEnableTransaction(test.options());

    expect((await test.readConfig()).webTools.enabled).toBe(true);
    expect(result.readback).toEqual([
      { source: 'api:ws-only', fingerprint: result.effectiveConfigFingerprint },
    ]);
    expect(test.journal.record('webTools')).toEqual({
      status: 'passed',
      validatedAt: '2026-09-01T00:00:00.000Z',
      configFingerprint: capabilityConfigFingerprint(test.effective.config, 'webTools'),
    });
    // 提交后的 Secret 必须仍然可读，否则热更新后的运行时立刻失效。
    await expect(test.vault.getSecret(test.stagedRefs[0]!, READER)).resolves.toBe('brave-live-key');
  });

  it('探测失败时配置不变，并撤销本次暂存的 Secret', async () => {
    const test = await fixture();
    const staging = new SecretStagingArea(test.vault, CALLER);
    await expectEnableError(
      runCapabilityEnableTransaction(
        test.options({
          staging,
          probe: () => {
            throw new CapabilityEnableError('CAPABILITY_PROBE_FAILED', '搜索上游返回 401');
          },
        }),
      ),
      'CAPABILITY_PROBE_FAILED',
    );

    expect((await test.readConfig()).webTools.enabled).toBe(false);
    await expect(test.vault.getSecret(test.stagedRefs[0]!, READER)).rejects.toThrow(
      'secret revoked',
    );
    // 能力当前未启用，失败记录不会把状态页搅成一片红。
    expect(test.journal.record('webTools')?.status).toBe('failed');
  });

  it('候选配置不完整时不写 Secret 也不碰配置', async () => {
    const test = await fixture();
    const prepare = vi.fn();
    await expectEnableError(
      runCapabilityEnableTransaction(
        test.options({
          prepare,
          validateCandidate: () => {
            throw new CapabilityEnableError(
              'CAPABILITY_CONFIG_INCOMPLETE',
              '缺少搜索 Provider 凭据',
              {
                missing: ['webTools.search.apiKeyRef'],
              },
            );
          },
        }),
      ),
      'CAPABILITY_CONFIG_INCOMPLETE',
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await test.readConfig()).webTools.enabled).toBe(false);
  });

  it('过期指纹返回配置冲突并带上当前指纹', async () => {
    const test = await fixture();
    const error = await expectEnableError(
      runCapabilityEnableTransaction(
        test.options({ expectedFingerprint: `sha256:${'0'.repeat(64)}` }),
      ),
      'CAPABILITY_CONFIG_CONFLICT',
    );
    expect(error.details.effectiveConfigFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect((await test.readConfig()).webTools.enabled).toBe(false);
  });

  it('读回指纹不收敛时恢复到变更前配置', async () => {
    const test = await fixture();
    const restored: AppConfig[] = [];
    const error = await expectEnableError(
      runCapabilityEnableTransaction(
        test.options({
          applyRuntime: (next) => {
            restored.push(next);
            test.effective.config = next;
          },
          readEffectiveFingerprints: async () => [
            { source: 'runtime-worker', fingerprint: `sha256:${'1'.repeat(64)}` },
          ],
          convergence: { attempts: 2, delayMs: 0 },
        }),
      ),
      'CAPABILITY_RUNTIME_NOT_READY',
    );

    expect(error.details.readback).toEqual([
      { source: 'runtime-worker', fingerprint: `sha256:${'1'.repeat(64)}` },
    ]);
    expect((await test.readConfig()).webTools.enabled).toBe(false);
    // 第二次 applyRuntime 是回滚调用：进程内配置也必须回到变更前。
    expect(restored).toHaveLength(2);
    expect(test.effective.config.webTools?.enabled).toBe(false);
  });

  it('高风险变更缺少审批引用时直接拒绝', async () => {
    const test = await fixture();
    const prepare = vi.fn();
    await expectEnableError(
      runCapabilityEnableTransaction(
        test.options({ prepare, approval: { required: true, message: 'Production 需要审批编号' } }),
      ),
      'CAPABILITY_APPROVAL_REQUIRED',
    );
    expect(prepare).not.toHaveBeenCalled();
    expect((await test.readConfig()).webTools.enabled).toBe(false);
  });

  it('错误码映射到可区分的 HTTP 状态', () => {
    expect(capabilityEnableHttpStatus('CAPABILITY_CONFIG_CONFLICT')).toBe(409);
    expect(capabilityEnableHttpStatus('CAPABILITY_APPROVAL_REQUIRED')).toBe(403);
    expect(capabilityEnableHttpStatus('CAPABILITY_CONFIG_INCOMPLETE')).toBe(422);
    expect(capabilityEnableHttpStatus('CAPABILITY_PROBE_FAILED')).toBe(502);
    expect(capabilityEnableHttpStatus('CAPABILITY_RUNTIME_NOT_READY')).toBe(503);
  });

  it('没有 SecretVault 时暂存直接报缺 Secret', async () => {
    const staging = new SecretStagingArea(undefined, CALLER);
    await expect(staging.stage('web_tools', 'value')).rejects.toMatchObject({
      code: 'CAPABILITY_SECRET_MISSING',
    });
  });
});

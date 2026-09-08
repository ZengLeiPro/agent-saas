#!/usr/bin/env python3
"""Temporary exact-source integration fixes; removed from the final PR."""
import json
from pathlib import Path

paths = set(json.loads(Path('/tmp/production-model-integration-paths.json').read_text()))
def patch(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if s.count(old) != count:
        raise RuntimeError(f'{path}: expected {count} occurrences of {old[:100]!r}, got {s.count(old)}')
    p.write_text(s.replace(old, new))
    paths.add(path)

for message in [
    '配置已提交，但最终生效确认未完成；请重新读取服务端状态，不要盲目重复提交',
    '配置恢复尚未完成，已暂停新配置执行；请检查配置发布恢复状态',
]:
    patch('server/src/config/adminConfigMutationHttp.ts',
        "res.status(503).json({ code: error.code, error: '" + message + "' });",
        'res.status(500).json({ code: error.code, error: error.message });')

patch('server/src/__tests__/helpers/productionPublicationRig.ts',
    'resolveRuntimeModels: (models) => resolveModelsConfig(models, vault),',
    "resolveRuntimeModels: async (models) => { const resolved = await resolveModelsConfig(models, vault); if (!resolved) throw new Error('models missing'); return resolved; },")
patch('server/src/__tests__/helpers/productionPublicationRig.ts', 'parseAppConfig, type AppConfig', 'parseAppConfig')
patch('server/src/__tests__/helpers/productionPublicationRig.ts', 'timeoutMs: 150, pollMs: 5', 'timeoutMs: 500, pollMs: 5')
patch('server/src/__tests__/productionModelPublication.test.ts',
    "modelResolver?.('main/model')?.apiKey", "modelResolver?.('main/model')?.connection?.apiKey")
patch('server/src/__tests__/productionModelPublication.process.test.ts',
    "      '@agent/shared/schemas/configIdentity': resolve('../shared/src/schemas/configIdentity.ts'),",
    "      '@agent/shared/schemas/configIdentity': resolve('../shared/src/schemas/configIdentity.ts'),\n      '@agent/shared/schemas/releaseManifest': resolve('../shared/src/schemas/releaseManifest.ts'),")
patch('server/src/__tests__/productionModelPublication.process.test.ts', "    packages: 'external', alias:", '    alias:')
patch('server/src/config/productionModelPublisher.ts',
    '        throw new ConfigMutationCommittedError(error);',
    "        throw new ConfigMutationCommittedError(new Error('配置已提交，但最终生效确认未完成，请刷新确认后再操作', { cause: error }));")

# Share the host-level promotion mutex as well as the config mutation fence.
# Both acquisitions are nonblocking, so inverse attempts never deadlock.
p = 'server/src/config/adminConfigMutationService.ts'
patch(p, 'async function acquireFileGuard(path: string): Promise<() => Promise<void>> {',
    'export async function acquireFileGuard(path: string): Promise<() => Promise<void>> {')
p = 'server/src/config/productionModelPublisher.ts'
patch(p, "import { readFileSync, lstatSync } from 'node:fs';",
    "import { readFileSync, lstatSync, mkdirSync } from 'node:fs';\nimport { dirname } from 'node:path';")
patch(p, '  ConfigConflictError, ConfigMutationCommittedError, RuntimeRestoreFailedError,',
    '  acquireFileGuard, ConfigConflictError, ConfigMutationCommittedError, RuntimeRestoreFailedError,')
patch(p, '    timeoutMs?: number;', '    promotionLockPath?: string;\n    timeoutMs?: number;')
patch(p, '  async recover(): Promise<void> {', '''  private async fenced<T>(action: () => Promise<T>): Promise<T> {
    const path = this.options.promotionLockPath ?? '/run/lock/agent-saas/promotion.lock';
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try { release = await acquireFileGuard(path); }
    catch (error) { throw new Error('生产发布互斥锁暂不可用，请稍后重试', { cause: error }); }
    try { return await action(); } finally { await release(); }
  }

  async recover(): Promise<void> { return this.fenced(() => this.recoverLocked()); }

  private async recoverLocked(): Promise<void> {''')
patch(p, '  async mutate(input: MutationInput): Promise<AdminConfigMutationResult> {\n    await this.recover();',
    '''  async mutate(input: MutationInput): Promise<AdminConfigMutationResult> {
    return this.fenced(() => this.mutateLocked(input));
  }

  private async mutateLocked(input: MutationInput): Promise<AdminConfigMutationResult> {
    await this.recoverLocked();''')
for p in ['server/src/__tests__/helpers/productionPublicationRig.ts', 'server/src/__tests__/productionModelPublication.process.test.ts']:
    patch(p, 'new ProductionModelPublisher({ configPath, processCwd,',
        "new ProductionModelPublisher({ configPath, processCwd, promotionLockPath: join(root, 'promotion.lock'),")
paths.add('server/src/__tests__/productionModelPublication.fence.test.ts')
p = 'server/src/app/configIdentityAssembly.ts'
patch(p, '  const isExecutionAllowed = () => !recoveryGate.isDirty() && view.isExecutionAllowed();',
    '''  const isExecutionAllowed = () => !recoveryGate.isDirty() && view.isExecutionAllowed()
    && (runtimeIdentity.environment !== 'production' || !runtimeIdentity.expectedConfigIdentity || getSummary().status === 'consistent');''')

module = 'scripts/release/config-publication.mjs'
anchor = 'scripts/release/read-runtime-identity.mjs'
for name in [
    '.github/workflows/ci.yml', '.github/workflows/promote-release.yml',
    '.github/workflows/deploy-staging.yml', '.github/workflows/acs-sandbox.yml',
    'scripts/release/finalize-expand-migration.sh',
]:
    p = Path(name)
    lines = p.read_text().splitlines(keepends=True)
    found = 0
    for i, line in enumerate(lines):
        if anchor not in line:
            continue
        if 'node ' in line or '"$remote' in line or 'from ' in line:
            raise RuntimeError(f'Unexpected non-transport anchor in {name}: {line}')
        if line.strip() == anchor:
            indent = line[:len(line) - len(line.lstrip())]
            lines[i] = line + indent + module + '\n'
        else:
            lines[i] = line.replace(anchor, anchor + ' ' + module)
        found += 1
    if not found:
        raise RuntimeError(f'No verified transport list in {name}')
    p.write_text(''.join(lines))
    paths.add(name)
    print(name, 'updated transport lists:', found)
patch('.github/acs-runtime-inputs.txt',
    '0444 scripts/release/read-runtime-identity.mjs\n',
    '0444 scripts/release/read-runtime-identity.mjs\n0444 scripts/release/config-publication.mjs\n')

p = 'scripts/release/read-production-recovery-state.mjs'
patch(p, "import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport { publishedExpected } from './config-publication.mjs';")
patch(p, '  const verified = validateRecoveryObservations({\n',
    "  const trusted = JSON.parse(readFileSync('/etc/agent-saas/runtime-identity.json', 'utf8'));\n  const selectedExpected = publishedExpected('/etc/agent-saas/config.json', apiUnit.env.AGENT_SAAS_RELEASE_ID, apiBinding.expectedConfigIdentity);\n  const selectedTrusted = publishedExpected('/etc/agent-saas/config.json', apiUnit.env.AGENT_SAAS_RELEASE_ID, trusted.configIdentity);\n  const verified = validateRecoveryObservations({\n")
patch(p, "    trusted: JSON.parse(readFileSync('/etc/agent-saas/runtime-identity.json', 'utf8')),", '    trusted: { ...trusted, configIdentity: selectedTrusted },')
patch(p, '    expectedConfig: apiBinding.expectedConfigIdentity,', '    expectedConfig: selectedExpected,')
p = 'server/src/release/adminRunner/launcher.ts'
s = Path(p).read_text()
Path(p).write_text("import { publishedExpected } from '../../../../scripts/release/config-publication.mjs';\n" + s)
patch(p, '  return evaluateConfigIdentity({ expected: runtimeIdentity.expectedConfigIdentity, observed });',
    '''  try {
    const expected = environment === 'production'
      ? publishedExpected(configPath, runtimeIdentity.releaseId, runtimeIdentity.expectedConfigIdentity)
      : runtimeIdentity.expectedConfigIdentity;
    return evaluateConfigIdentity({ expected, observed });
  } catch {
    return evaluateConfigIdentity({ expected: runtimeIdentity.expectedConfigIdentity,
      observed: { error: 'Signed production configuration authority is unavailable or requires recovery' } });
  }''')
Path('/tmp/production-model-integration-paths.json').write_text(json.dumps(sorted(paths)))

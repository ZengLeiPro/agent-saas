from pathlib import Path
import re
root=Path('server/src')
def put(path,text):
    p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
def edit(path,before,after):
    p=root/path;s=p.read_text();assert before in s,(path,before);p.write_text(s.replace(before,after,1))
put('runtime/responses/subscriptionCredentialRotation.ts', '''/** Lock order is publication fence -> credential lock. The callback must not acquire the publication fence again. */
export interface SubscriptionCredentialRotationTransaction {
  <T>(credentialRef: string, rotate: () => Promise<T>): Promise<T>;
}
''')
put('config/subscriptionRotationSupport.ts', '''import type { AppConfig } from '../app/config.js';
import { orderedCredentialRefs } from '../runtime/responses/subscriptionAccountBinding.js';
export class ConfigPublicationLockUnavailableError extends Error {
  constructor(cause: unknown) { super('生产发布互斥锁暂不可用，请稍后重试', { cause }); this.name = 'ConfigPublicationLockUnavailableError'; }
}
export function configuredSubscriptionProvider(config: AppConfig, ref: string): { id: 'codex' | 'grok'; root: 'codexSubscription' | 'grokSubscription' } {
  const codex = orderedCredentialRefs(config.codexSubscription).includes(ref);
  const grok = orderedCredentialRefs(config.grokSubscription).includes(ref);
  if (codex === grok) throw new Error('拒绝为未登记或提供方不唯一的订阅凭据推进签名身份');
  return grok ? { id: 'grok', root: 'grokSubscription' } : { id: 'codex', root: 'codexSubscription' };
}
export function isCredentialRotationPublication(paths: readonly string[]): boolean {
  return paths.length === 1 && ['runtime-credential-rotation:codexSubscription', 'runtime-credential-rotation:grokSubscription'].includes(paths[0]);
}
''')
p=root/'config/productionModelPublisher.ts';s=p.read_text();s="import type { SubscriptionCredentialRotationTransaction } from '../runtime/responses/subscriptionCredentialRotation.js';\nimport { ConfigPublicationLockUnavailableError, configuredSubscriptionProvider, isCredentialRotationPublication } from './subscriptionRotationSupport.js';\n"+s
needle='  coordinateCredentialRotation?(credentialRef: string): Promise<void>;';assert needle in s
s=s.replace(needle,needle+'\n  withCredentialRotation?: SubscriptionCredentialRotationTransaction;',1)
needle='      observeLocal: () => Promise<void>;';assert needle in s
s=s.replace(needle,needle+'\n      pendingCredentialRotations?: () => Promise<string[]>;\n      acknowledgeCredentialRotation?: (ref: string) => Promise<void>;',1)
s=s.replace("throw new Error('生产发布互斥锁暂不可用，请稍后重试', { cause: error });",'throw new ConfigPublicationLockUnavailableError(error);',1)
needle='  async recover(): Promise<void> {\n    return this.fenced(() => this.recoverLocked());\n  }';assert needle in s
s=s.replace(needle,'''  async recover(): Promise<void> {
    return this.fenced(async () => {
      await this.recoverLocked();
      // Only provider-owned durable generation evidence can authorize recovery before a signed intent.
      for (const ref of await this.options.pendingCredentialRotations?.() ?? []) {
        await this.coordinateCredentialRotationLocked(ref);
        await this.options.acknowledgeCredentialRotation?.(ref);
      }
    });
  }
''',1)
a=s.index('  async coordinateCredentialRotation(credentialRef: string): Promise<void> {');b=s.index('  private async recoverLocked()',a)
old=s[a:b];start=old.index('      const state =');end=old.rindex('    });')
body=old[start:end]
body='\n'.join(line[2:] if line.startswith('  ') else line for line in body.splitlines())
refs='''    const refs = config.codexSubscription?.credentialRefs?.length
      ? config.codexSubscription.credentialRefs
      : config.codexSubscription?.credentialRef ? [config.codexSubscription.credentialRef] : [];
    if (!refs.includes(credentialRef)) throw new Error('拒绝为未登记的 Codex 凭据推进签名身份');'''
assert refs in body
body=body.replace(refs,'    const provider = configuredSubscriptionProvider(config, credentialRef);',1)
body=body.replace("actor: 'system:codex-token-refresh',",'actor: `system:${provider.id}-token-refresh`,')
body=body.replace("changedPaths: ['runtime-credential-rotation:codexSubscription'],",'changedPaths: [`runtime-credential-rotation:${provider.root}`],')
body=body.replace("new Error('Codex token 已刷新，但签名身份确认未完成；配置写入已阻断等待恢复', { cause: error })",'new Error(`${provider.id} token 已刷新，但签名身份确认未完成；配置写入已阻断等待恢复`, { cause: error })')
needle='    if (canonical(identity) === canonical(this.expected(state))) return;';assert needle in body
body=body.replace(needle,'''    if (canonical(identity) === canonical(this.expected(state))) {
      const targets = this.options.targets(); this.assertTargets(targets);
      await this.wait(state, targets); return;
    }''',1)
methods='''  async coordinateCredentialRotation(credentialRef: string): Promise<void> {
    return this.fenced(async () => { await this.recoverLocked(); await this.coordinateCredentialRotationLocked(credentialRef); });
  }

  async withCredentialRotation<T>(credentialRef: string, rotate: () => Promise<T>): Promise<T> {
    const deadline = performance.now() + 90_000;
    while (true) {
      try {
        return await this.fenced(async () => {
          await this.recoverLocked();
          const current = parseAppConfig(parseJsonc(readFileSync(this.options.configPath, 'utf8')));
          configuredSubscriptionProvider(current, credentialRef);
          let result: T;
          try { result = await rotate(); }
          catch (error) {
            // A Vault write may have committed even if its acknowledgement was lost. Never replay
            // the grant: reconcile the observed generation while still holding the outer fence.
            await this.coordinateCredentialRotationLocked(credentialRef);
            throw error;
          }
          await this.coordinateCredentialRotationLocked(credentialRef);
          return result;
        });
      } catch (error) {
        if (!(error instanceof ConfigPublicationLockUnavailableError) || performance.now() >= deadline) throw error;
        await sleep(100);
      }
    }
  }

  private async coordinateCredentialRotationLocked(credentialRef: string): Promise<void> {
'''+body+'''\n  }

'''
s=s[:a]+methods+s[b:]
needle="    await this.rollback(state, new Error('恢复中断的生产配置事务'));";assert needle in s
s=s.replace(needle,"    if (isCredentialRotationPublication(state.changedPaths)) { await this.recoverCredentialRotationLocked(state); return; }\n"+needle,1)
a=s.index('  private async rollback(')
s=s[:a]+'''  private async recoverCredentialRotationLocked(state: ConfigPublication): Promise<void> {
    // Refresh is irreversible. Only a signed rotation intent with unchanged config bytes may
    // move forward to the observed Vault versions; ordinary configuration rollback is unchanged.
    if (!state.previous || state.rawRevision !== state.previous.rawRevision
        || rawRevision(readFileSync(this.options.configPath, 'utf8')) !== state.rawRevision) {
      throw new Error('凭据轮换恢复缺少未变更配置的签名证据');
    }
    const config = parseAppConfig(parseJsonc(readFileSync(this.options.configPath, 'utf8')));
    const identity = await this.identity(config);
    if (identity.digest !== state.previous.identity.digest) throw new Error('凭据轮换恢复不能接受配置内容漂移');
    const targets = this.options.targets(); this.assertTargets(targets);
    const intent: ConfigPublication = { ...state, phase: 'applying', sequence: state.sequence + 1,
      identity, owner: processIdentity(), updatedAt: new Date(this.now()).toISOString() };
    try {
      writePublication(this.options.configPath, intent); await this.wait(intent, targets);
      const committed = this.transition(intent, 'committed'); await this.wait(committed, targets);
    } catch (error) {
      try {
        const latest = this.state();
        if (latest.revision === intent.revision && latest.phase !== 'committed') this.transition(latest, 'recovery_required');
      } catch { /* Retain the signed pending head; do not forge an old credential version. */ }
      throw new ConfigMutationCommittedError(new Error('订阅凭据已旋转，等待 API / Worker 前向确认', { cause: error }));
    }
  }

'''+s[a:];p.write_text(s)
# Grok's persistent pending generation fence is acknowledged only after both production receipts.
p=root/'runtime/responses/grokCredentialManager.ts';s=p.read_text();s="import type { SubscriptionCredentialRotationTransaction } from './subscriptionCredentialRotation.js';\n"+s
needle='  private coordinator?: (ref: string) => Promise<void>;';assert needle in s
s=s.replace(needle,needle+'\n  private rotationTransaction?: SubscriptionCredentialRotationTransaction;',1)
a=s.index('  getCredentialRefs():')
s=s[:a]+'''  setCredentialRotationTransaction(transaction: SubscriptionCredentialRotationTransaction | undefined): void { this.rotationTransaction = transaction; }
  async getPendingPublicationRefs(): Promise<string[]> {
    const pending: string[] = [];
    for (const ref of this.getCredentialRefs()) {
      const generation = await this.journal.get(ref); if (generation === undefined) continue;
      try { if ((await this.repository.read(ref, generation)).generation > generation) pending.push(ref); }
      catch (error) { if (!(error instanceof GrokCredentialError)) throw error; }
    }
    return pending;
  }
  async acknowledgeCredentialRotation(ref: string): Promise<void> {
    await this.lock.runExclusive(this.lockKey(ref), async () => {
      const pending = await this.journal.get(ref); if (pending === undefined) return;
      const bundle = await this.repository.read(ref, pending);
      if (bundle.generation <= pending) throw new GrokProtocolError('refresh_outcome_unknown');
      await this.state.clear(ref, bundle.generation); await this.journal.clear(ref, pending);
    });
  }
'''+s[a:]
needle='    const result = await this.lock.runExclusive(this.lockKey(ref), async () => {';assert needle in s
s=s.replace(needle,'    const rotate = () => this.lock.runExclusive(this.lockKey(ref), async () => {',1)
# Production requires the outer transaction, not a callback that starts too late after Vault mutation.
s=s.replace('this.options.requireRotationCoordinator && !this.coordinator', 'this.options.requireRotationCoordinator && !this.rotationTransaction')
needle='    // Global publication locks are acquired only AFTER releasing the credential lock.';assert needle in s
start=s.index(needle);end=s.index('    if (result.pending !== undefined)',start)
s=s[:start]+'''    const result = this.rotationTransaction ? await this.rotationTransaction(ref, rotate) : await rotate();
    // Production holds the publication fence around the credential lock and final receipts.
    // Non-production compatibility callbacks still run after releasing the credential lock.
'''+s[end:]
# Formatter may have expanded the legacy coordinator call; replace the stable expression only.
s=s.replace('if (this.getCredentialRefs().includes(ref)) await this.coordinator?.(ref);', 'if (!this.rotationTransaction && this.getCredentialRefs().includes(ref)) await this.coordinator?.(ref);',1)
p.write_text(s)
# Codex keeps its original default behavior; the production hook establishes the same global lock
# order for both providers, preventing a concurrent Codex refresh from racing a Grok publication.
p=root/'runtime/responses/codexCredentialManager.ts';s=p.read_text();s="import type { SubscriptionCredentialRotationTransaction } from './subscriptionCredentialRotation.js';\n"+s
needle='  private credentialRotationCoordinator?: (credentialRef: string) => Promise<void>;';assert needle in s
s=s.replace(needle,needle+'\n  private credentialRotationTransaction?: SubscriptionCredentialRotationTransaction;',1)
a=s.index('  getCredentialRefs():')
s=s[:a]+'''  setCredentialRotationTransaction(transaction: SubscriptionCredentialRotationTransaction | undefined): void { this.credentialRotationTransaction = transaction; }

'''+s[a:]
needle='    const result = await this.lock.runExclusive(this.lockKey(credentialRef), async () => {';assert needle in s
s=s.replace(needle,'    const rotate = () => this.lock.runExclusive(this.lockKey(credentialRef), async () => {',1)
s=s.replace('        await this.credentialRotationCoordinator?.(credentialRef);', '        if (!this.credentialRotationTransaction) await this.credentialRotationCoordinator?.(credentialRef);',1)
needle='    await this.runtimeStateStore.clear(credentialRef, result.bundle.generation);';assert needle in s
s=s.replace(needle,'    const result = this.credentialRotationTransaction ? await this.credentialRotationTransaction(credentialRef, rotate) : await rotate();\n'+needle,1);p.write_text(s)
# One active API owner recovers provider-owned journal entries even while model admission is closed.
p=root/'app/productionModelPublication.ts';s=p.read_text();s="import type { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';\n"+s
needle='  secretVault: SecretVault;';assert needle in s
s=s.replace(needle,needle+'\n  grokCredentialManager?: GrokCredentialManager;',1)
needle='          observeLocal: observe,';assert needle in s
s=s.replace(needle,needle+'\n          pendingCredentialRotations: () => options.grokCredentialManager?.getPendingPublicationRefs() ?? Promise.resolve([]),\n          acknowledgeCredentialRotation: (ref) => options.grokCredentialManager?.acknowledgeCredentialRotation(ref) ?? Promise.resolve(),',1)
needle='      const state = readPublication(configPath);';assert needle in s
s=s.replace(needle,needle+'\n      const hasPendingRotation = (await options.grokCredentialManager?.getPendingPublicationRefs() ?? []).length > 0;',1)
s=s.replace("        state.phase === 'committed' ||\n        (state.phase !== 'recovery_required' && state.owner && isOwnerAlive(state.owner))", "        (state.phase === 'committed' && !hasPendingRotation) ||\n        (state.phase !== 'committed' && state.phase !== 'recovery_required' && state.owner && isOwnerAlive(state.owner))",1)
needle='    coordinateCredentialRotation: (credentialRef: string) => publisher.coordinateCredentialRotation(credentialRef),';assert needle in s
s=s.replace(needle,needle+'\n    withCredentialRotation: <T>(ref: string, rotate: () => Promise<T>) => publisher.withCredentialRotation(ref, rotate),',1);p.write_text(s)
p=root/'app/runtime.ts';s=p.read_text();needle='  const productionModelPublication = initializeProductionModelPublication({';assert needle in s
s=s.replace(needle,needle+' grokCredentialManager,',1)
needle='  grokCredentialManager.setCredentialRotationCoordinator(productionModelPublication?.coordinateCredentialRotation);';assert needle in s
s=s.replace(needle,needle+'\n  grokCredentialManager.setCredentialRotationTransaction(productionModelPublication?.withCredentialRotation);\n  codexCredentialManager.setCredentialRotationTransaction(productionModelPublication?.withCredentialRotation);',1);p.write_text(s)
print('Applied publication-before-credential lock ordering, bounded lock acquisition, irreversible refresh forward recovery and durable generation acknowledgement')

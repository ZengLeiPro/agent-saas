from pathlib import Path
import re
root = Path('server/src')
def put(path, text):
    p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
def edit(path,before,after):
    p=root/path;s=p.read_text();assert before in s,(path,before);p.write_text(s.replace(before,after,1))
# One authentication predicate; existing model visibility and run authorization remain unchanged.
p=root/'runtime/subagent/subagentRunner.ts';s=p.read_text();s="import { modelRequiresApiKey } from '../subscriptionModelAuthentication.js';\n"+s
assert "providerOptions?.responsesTransport !== 'codex_subscription'" in s;s=s.replace("providerOptions?.responsesTransport !== 'codex_subscription'",'modelRequiresApiKey(providerOptions)');p.write_text(s)
p=root/'app/orgAgentDispatcherRuntime.ts';s=p.read_text();s="import { isSubscriptionTransport } from '../runtime/subscriptionModelAuthentication.js';\n"+s
assert "resolved.providerOptions?.responsesTransport === 'codex_subscription'" in s;s=s.replace("resolved.providerOptions?.responsesTransport === 'codex_subscription'",'isSubscriptionTransport(resolved.providerOptions?.responsesTransport)');p.write_text(s)
p=root/'app/models.ts';s=p.read_text();s="import { isSubscriptionTransport } from '../runtime/subscriptionModelAuthentication.js';\n"+s
assert "responsesTransport !== 'codex_subscription'" in s;s=s.replace("responsesTransport !== 'codex_subscription'",'!isSubscriptionTransport(responsesTransport)');p.write_text(s)
p=root/'agent/titleGenerator.ts';s=p.read_text();s="import { isSubscriptionTransport } from '../runtime/subscriptionModelAuthentication.js';\n"+s
s=s.replace("config.responsesTransport === 'codex_subscription'",'isSubscriptionTransport(config.responsesTransport)')
s=s.replace("    responsesTransport: 'codex_subscription',",'    responsesTransport: input.config.responsesTransport,',1)
s=s.replace('isCodexSubscription','isSubscription').replace('runCodexTitleOperation','runSubscriptionTitleOperation').replace('codexTitleInFlight','subscriptionTitleInFlight')
s=s.replace('  const key = input.config.model;',"  const key = JSON.stringify([input.config.responsesTransport, input.config.model, input.runtimeContext.tenantId ?? '', input.runtimeContext.sessionId]);",1)
s=s.replace('codex_subscription runtime is unavailable','${config.responsesTransport} runtime is unavailable')
s=s.replace("new Error('Codex title generation is still in flight')",'new Error(`${input.config.responsesTransport} title generation is still in flight`)')
s=s.replace('`Codex title generation ${event.terminalStatus}`','`${input.config.responsesTransport} title generation ${event.terminalStatus}`')
s=s.replace("'Codex title generation ended without terminal event'",'`${input.config.responsesTransport} title generation ended without terminal event`')
p.write_text(s)
# Explicitly restricted auxiliary services must never inherit OPENAI_API_KEY for a Grok model.
edit('runtime/imageUnderstanding.ts', '  const images = attachments.filter(', "  if (configs.some((config) => config.providerOptions?.responsesTransport === 'grok_subscription')) throw new Error('MODEL_TRANSPORT_UNSUPPORTED: Grok subscription 尚未支持独立图片理解辅助路径');\n  const images = attachments.filter(")
edit('app/guardrailModelConfigs.ts', '    configs.push({ model: resolved.model, connection: resolved.connection });', "    if (resolved.providerOptions?.responsesTransport === 'grok_subscription') throw new Error('MODEL_TRANSPORT_UNSUPPORTED: Grok subscription 尚未支持内容安全门禁辅助路径');\n    configs.push({ model: resolved.model, connection: resolved.connection });")
put('app/subscriptionModelConfigValidation.ts', '''import { z } from 'zod';
interface SubscriptionModel { id: string; protocol?: string; responses_transport?: string }
interface SubscriptionGroup { id: string; protocol?: string; responses_transport?: string; models: SubscriptionModel[] }
interface SubscriptionConfiguration {
  models?: { groups: SubscriptionGroup[]; imageUnderstanding?: { model: string; fallbackModels?: string[] } };
  guardrail?: { model?: string; fallbackModels?: string[] };
  codexSubscription?: unknown; grokSubscription?: unknown;
}
/** Shared configuration gate; standalone API-key auxiliaries are never silently substituted. */
export function validateSubscriptionModels(value: SubscriptionConfiguration, ctx: z.RefinementCtx): void {
  for (const [groupIndex, group] of (value.models?.groups ?? []).entries()) {
    for (const [modelIndex, model] of group.models.entries()) {
      const transport = model.responses_transport ?? group.responses_transport;
      if (transport !== 'codex_subscription' && transport !== 'grok_subscription') continue;
      const root = transport === 'grok_subscription' ? 'grokSubscription' : 'codexSubscription';
      if ((model.protocol ?? group.protocol ?? 'chat_completions') !== 'responses') ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['models', 'groups', groupIndex, 'models', modelIndex, 'responses_transport'],
        message: `${transport} 只能用于 protocol="responses"`,
      });
      if (!value[root]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [root], message: `存在 ${transport} 模型时必须配置 ${root}` });
    }
  }
  const auxiliaries = [
    { path: ['guardrail'], config: value.guardrail, label: '内容安全门禁' },
    { path: ['models', 'imageUnderstanding'], config: value.models?.imageUnderstanding, label: '独立图片理解' },
  ];
  for (const { path, config, label } of auxiliaries) {
    for (const [index, ref] of [config?.model, ...(config?.fallbackModels ?? [])].entries()) {
      if (!ref) continue;
      const slash = ref.indexOf('/'); const group = value.models?.groups.find((entry) => entry.id === ref.slice(0, slash));
      const model = group?.models.find((entry) => entry.id === ref.slice(slash + 1));
      if (model && (model.responses_transport ?? group?.responses_transport) === 'grok_subscription') ctx.addIssue({
        code: z.ZodIssueCode.custom, path: [...path, ...(index === 0 ? ['model'] : ['fallbackModels', index - 1])],
        message: `Grok 订阅尚未支持${label}辅助路径；不会切换到 API Key 计费。`,
      });
    }
  }
}
''')
p=root/'app/config.ts';s=p.read_text();a=s.index('  for (const [groupIndex, group] of (value.models?.groups ?? []).entries()) {',s.index('}).superRefine((value, ctx) => {'));b=s.index('\n});',a)
s=s[:a]+'  validateSubscriptionModels(value, ctx);'+s[b:];s="import { validateSubscriptionModels } from './subscriptionModelConfigValidation.js';\n"+s;p.write_text(s)
# Both API and worker consume the same optional root, including rollback to no configuration.
p=root/'app/sharedConfigRefresher.ts';s=p.read_text()
s=s.replace('  codexSubscription: boolean;','  codexSubscription: boolean;\n  grokSubscription: boolean;',1)
s=s.replace("  codexSubscription: 'codexSubscription',", "  codexSubscription: 'codexSubscription',\n  grokSubscription: 'grokSubscription',",1)
s=s.replace('  onCodexSubscriptionUpdated?: (credentialRefs?: readonly string[]) => void;', '  onCodexSubscriptionUpdated?: (credentialRefs?: readonly string[]) => void;\n  onGrokSubscriptionUpdated?: () => void;',1)
needle='      codexSubscription:\n        JSON.stringify(config.codexSubscription ?? null) !==\n        JSON.stringify(nextConfig.codexSubscription ?? null),';assert needle in s
s=s.replace(needle,needle+'\n      grokSubscription: JSON.stringify(config.grokSubscription ?? null) !== JSON.stringify(nextConfig.grokSubscription ?? null),',1)
needle='    if (changes.codexSubscription) {\n      if (source.codexSubscription) config.codexSubscription = source.codexSubscription;\n      else delete config.codexSubscription;\n    }';assert needle in s
s=s.replace(needle,needle+'\n    if (changes.grokSubscription) {\n      if (source.grokSubscription) config.grokSubscription = source.grokSubscription;\n      else delete config.grokSubscription;\n    }',1)
needle="    if (changes.toolControls) logger?.info('[SharedConfig] 已从磁盘热更新工具开关与描述覆盖配置');";assert needle in s
s=s.replace(needle,needle+"\n    if (changes.grokSubscription) {\n      params.onGrokSubscriptionUpdated?.();\n      logger?.info(`[SharedConfig] 已从磁盘热更新 Grok 订阅配置：enabled=${nextConfig.grokSubscription?.enabled === true}`);\n    }",1)
needle="changes.codexSubscription && !params.onCodexSubscriptionUpdated ? 'codexSubscription' : undefined,";assert needle in s
s=s.replace(needle,needle+"\n      changes.grokSubscription && !params.onGrokSubscriptionUpdated ? 'grokSubscription' : undefined,",1);p.write_text(s)
p=root/'app/modelResolvers.ts';s=p.read_text();s=s.replace('  onCodexSubscriptionUpdated?: (credentialRefs?: readonly string[]) => void;', '  onCodexSubscriptionUpdated?: (credentialRefs?: readonly string[]) => void;\n  onGrokSubscriptionUpdated?: () => void;',1)
needle='    ...(params.onCodexSubscriptionUpdated\n      ? { onCodexSubscriptionUpdated: params.onCodexSubscriptionUpdated }\n      : {}),';assert needle in s
s=s.replace(needle,needle+'\n    ...(params.onGrokSubscriptionUpdated ? { onGrokSubscriptionUpdated: params.onGrokSubscriptionUpdated } : {}),',1);p.write_text(s)
edit('app/runtime.ts','    onCodexSubscriptionUpdated: (refs) => {','    onGrokSubscriptionUpdated: () => grokModelCatalog.invalidate(),\n    onCodexSubscriptionUpdated: (refs) => {')
# Managed credential projection stores refs and opaque Vault versions, never token hashes or identities.
p=root/'release/configIdentity.ts';s=p.read_text();s=s.replace("  ['codexSubscription', 'credentialRef'],","  ['codexSubscription', 'credentialRef'],\n  ['grokSubscription', 'credentialRef'],",1)
s=s.replace("  ['codexSubscription', 'endpoint'],","  ['codexSubscription', 'endpoint'],\n  ['grokSubscription', 'endpoint'],",1)
s=s.replace("if (pathMatches(path, ['codexSubscription', 'credentialRefs'])) {", "if (pathMatches(path, ['codexSubscription', 'credentialRefs']) || pathMatches(path, ['grokSubscription', 'credentialRefs'])) {",1);p.write_text(s)
p=root/'config/effectiveConfigStatus.ts';s=p.read_text();s=s.replace("path.startsWith('codexSubscription.')", "path.startsWith('codexSubscription.') || path.startsWith('grokSubscription.')");p.write_text(s)
# Pin permanent schema limits without rejecting legacy long, safe runtime table prefixes when disabled.
p=root/'runtime/responses/subscriptionRefreshJournal.ts';s=p.read_text();s=s.replace("/^[a-zA-Z_][a-zA-Z0-9_]{0,29}$/", "/^[a-zA-Z_][a-zA-Z0-9_]*$/")
# Keep deterministic provider suffixes within PostgreSQL's 63-byte identifier limit.
s=s.replace('this.table = `${prefix}_grok_credential_refresh_journal`;', 'this.table = `${prefix.slice(0, 30)}_grok_credential_refresh_journal`;')
p.write_text(s)
# A post-commit metadata failure must not be represented as a pre-publication failure.
p=root/'routes/grokSubscriptionCompletion.ts';s=p.read_text();needle='    return {\n      ...(await this.context.publicState()),';
if needle in s:
    start=s.index(needle,s.index('private async complete('));end=s.index('\n  }',start)
    body=s[start:end];s=s[:start]+'    try {\n'+body+'\n    } catch (error) { throw new ConfigMutationCommittedError(error); }'+s[end:]
else:
    print('AUDIT: completion post-commit metadata wrapping requires formatted source review')
p.write_text(s)
print('Applied all subscription authentication entry guards, title factory routing, explicit auxiliary limits, hot-update consumers and ref-only identity')

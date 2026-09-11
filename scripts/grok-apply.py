from pathlib import Path
import re
root=Path('web/src/components/ModelManager')
def put(path,text):
    p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
put('subscriptionModelForm.ts', '''import type { EditableGroup, EditableModel, ResponsesTransport } from './modelConfigTypes';
export function isSubscriptionTransport(value: unknown): value is 'codex_subscription' | 'grok_subscription' {
  return value === 'codex_subscription' || value === 'grok_subscription';
}
export function changeGroupTransport(group: EditableGroup, transport: ResponsesTransport): EditableGroup {
  if (!isSubscriptionTransport(transport)) return { ...group, responses_transport: transport };
  return { ...group, protocol: 'responses', responses_transport: transport,
    disable_response_chaining: true, disable_prompt_cache_key: transport === 'grok_subscription' ? true : undefined,
    ...(transport === 'grok_subscription' ? { mcp_loading_mode: 'eager', tool_search_protocol: 'none' } as const : {}),
    models: group.models.map((model) => model.responses_transport === 'openai_compatible' ? model : { ...model, protocol: undefined }) };
}
export function changeModelTransport(model: EditableModel, transport: ResponsesTransport | 'inherit'): EditableModel {
  if (transport === 'inherit') return { ...model, protocol: undefined, responses_transport: undefined };
  if (!isSubscriptionTransport(transport)) return { ...model, responses_transport: transport };
  return { ...model, protocol: 'responses', responses_transport: transport,
    ...(transport === 'grok_subscription' ? { mcp_loading_mode: 'eager', tool_search_protocol: 'none' } as const : {}) };
}
export function subscriptionTransportNotice(transport: unknown): string {
  if (transport === 'grok_subscription') return 'Grok 订阅固定使用完整历史 HTTP/SSE、store:false 和平台工具执行；不发送 previous_response_id 或 prompt_cache_key，不启用 WebSocket 接力。图像与 reasoning effort 按各账号订阅目录能力检查；未验证能力会明确拒绝。';
  if (transport === 'codex_subscription') return 'Codex 固定逻辑协议：`store:false`、每轮保留完整历史、禁止标准 HTTP `previous_response_id`、稳定 session cache key、encrypted reasoning replay。启用上方 WebSocket 接力后，只压缩线上发送内容；PostgreSQL 完整历史仍是事实源，异常会自动回退全量 HTTP/SSE。';
  return '订阅模型按各自 transport 使用平台授权池。Codex 的 WebSocket 与缓存策略不适用于 Grok；Grok 使用完整历史 HTTP/SSE。';
}
''')
put('grokCatalogImport.ts', '''import type { EditableModelsConfig, EditableModel } from './modelConfigTypes';
export interface GrokCatalogEntry {
  id: string; name?: string; contextWindow?: number; maxOutputTokens?: number;
  supportsReasoningEffort?: boolean; inputModalities?: Array<'text' | 'image'>;
}
export interface GrokCatalogResponse {
  source: 'subscription_catalog';
  models: Array<{ id: string; name?: string; eligibleCredentialRefs: string[] }>;
  accounts: Array<{ credentialRef: string; priority: number; status: 'fresh' | 'stale' | 'unknown';
    collectedAt?: string; error?: string; models: GrokCatalogEntry[] }>;
}
/** Only common, observed account capabilities become model metadata. Unknown never means unlimited. */
export function catalogImportEntries(catalog: GrokCatalogResponse, ids: readonly string[]): GrokCatalogEntry[] {
  return ids.map((id) => {
    const union = catalog.models.find((model) => model.id === id);
    if (!union || !union.eligibleCredentialRefs.length) throw new Error('所选模型尚无已确认的订阅账号资格，请重新采集目录。');
    const entries = union.eligibleCredentialRefs.map((ref) => catalog.accounts.find((account) => account.credentialRef === ref && account.status === 'fresh')?.models.find((model) => model.id === id));
    if (entries.some((entry) => !entry)) throw new Error('模型资格信息不完整，请重新采集目录。');
    const observed = entries as GrokCatalogEntry[];
    const windows = observed.map((entry) => entry.contextWindow);
    const contextWindow = windows.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ? Math.min(...windows as number[]) : undefined;
    return { id, name: union.name, ...(contextWindow ? { contextWindow } : {}),
      supportsReasoningEffort: observed.every((entry) => entry.supportsReasoningEffort === true),
      inputModalities: observed.every((entry) => entry.inputModalities?.includes('image')) ? ['text', 'image'] : ['text'] };
  });
}
export function importGrokCatalogModels(current: EditableModelsConfig, target: string, entries: GrokCatalogEntry[]): { models: EditableModelsConfig; imported: number } {
  if (!entries.length || entries.length > 100) throw new Error('每次请选择 1 到 100 个订阅模型。');
  const existing = current.groups.find((group) => group.id === target);
  if (target !== '__new__' && (!existing || existing.responses_transport !== 'grok_subscription')) throw new Error('请选择 Grok 订阅分组或明确新建一个分组。');
  if (existing && (existing.reasoning_effort || existing.reasoningEffort) && entries.some((entry) => entry.supportsReasoningEffort !== true)) throw new Error('该分组指定了思考深度，但目录未确认所有所选模型支持；请新建分组或先清除该设定。');
  let groupId = existing?.id ?? 'grok-subscription'; let suffix = 2;
  if (!existing) while (current.groups.some((group) => group.id === groupId)) groupId = `grok-subscription-${suffix++}`;
  const models = [...existing?.models ?? []]; let imported = 0;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(entry.id)) throw new Error('订阅目录模型 ID 无效。');
    if (models.some((model) => (model.value || model.id) === entry.id && (model.responses_transport ?? existing?.responses_transport) === 'grok_subscription')) continue;
    const baseId = entry.id.replace(/[^A-Za-z0-9._-]/g, '-'); let id = baseId; let n = 2;
    while (models.some((model) => model.id === id)) id = `${baseId}-${n++}`;
    const model: EditableModel = { id, name: entry.name || entry.id, value: entry.id,
      protocol: 'responses', responses_transport: 'grok_subscription', mcp_loading_mode: 'eager', tool_search_protocol: 'none',
      input_modalities: entry.inputModalities ?? ['text'], ...(entry.contextWindow ? { context_window: entry.contextWindow } : {}) };
    models.push(model); imported += 1;
  }
  if (!imported) return { models: current, imported };
  const group = existing ? { ...existing, models } : { id: groupId, name: 'Grok 订阅', protocol: 'responses' as const,
    responses_transport: 'grok_subscription' as const, mcp_loading_mode: 'eager' as const, tool_search_protocol: 'none' as const,
    disable_response_chaining: true, disable_prompt_cache_key: true, models };
  // Preserve platform default, helper references, existing prices and every unrelated group.
  return { models: { ...current, groups: existing ? current.groups.map((item) => item.id === existing.id ? group : item) : [...current.groups, group] }, imported };
}
''')
put('GrokModelCatalogPicker.tsx', '''import { useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { EditableGroup } from './modelConfigTypes';
import type { GrokSubscriptionState } from './subscriptionTypes';
import { GROK_ADMIN_API, readSubscriptionJson } from './grokSubscriptionClient';
import { catalogImportEntries, type GrokCatalogEntry, type GrokCatalogResponse } from './grokCatalogImport';
export function GrokModelCatalogPicker({ state, groups, readOnly, modelRevision, onRefreshModels, onImport }: {
  state: GrokSubscriptionState | null; groups: EditableGroup[]; readOnly: boolean; modelRevision: string;
  onRefreshModels: () => void | Promise<void>; onImport: (target: string, entries: GrokCatalogEntry[]) => number;
}) {
  const [catalog, setCatalog] = useState<GrokCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]); const [target, setTarget] = useState('__new__');
  const [message, setMessage] = useState<string | null>(null);
  const sameRevision = !!modelRevision && modelRevision === state?.revision;
  const collect = async () => {
    setLoading(true); setError(null); setMessage(null);
    try {
      const response = await authFetch(`${GROK_ADMIN_API}/models?refresh=true`);
      const data = await readSubscriptionJson<GrokCatalogResponse>(response);
      if (!response.ok || data.source !== 'subscription_catalog' || !Array.isArray(data.models) || !Array.isArray(data.accounts)) throw new Error(data.error ?? '订阅模型目录暂不可用。');
      setCatalog(data); setSelection((old) => old.filter((id) => data.models.some((model) => model.id === id && model.eligibleCredentialRefs.length)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '订阅目录采集失败；已配置模型保持不变。'); }
    finally { setLoading(false); }
  };
  const importModels = () => {
    if (!catalog || readOnly || !sameRevision || state?.writePolicy?.canSave !== true) return;
    try {
      const count = onImport(target, catalogImportEntries(catalog, selection));
      setMessage(count ? `已将 ${count} 个模型加入待保存配置。请点击页面顶部“保存并生效”；默认模型和价格未改变。` : '所选模型已经存在，未重复添加。'); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模型导入失败'); }
  };
  return <section className="space-y-3 border-t pt-3" aria-label="Grok 订阅模型目录">
    <div className="flex flex-wrap items-center justify-between gap-2"><div>
      <p className="text-sm font-medium">订阅模型目录</p><p className="text-xs text-muted-foreground">逐账号采集资格；不会使用 Console API 目录代替订阅目录。</p>
    </div><Button type="button" size="sm" variant="outline" disabled={loading || !state?.config.enabled || !state.credentials.length} onClick={() => void collect()}>{loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}采集订阅目录</Button></div>
    {catalog && <>
      <div className="space-y-1 text-xs text-muted-foreground">{catalog.accounts.map((account) => <div key={account.credentialRef}>
        优先级 {account.priority}：{account.status === 'fresh' ? `已确认 ${account.models.length} 个模型` : account.status === 'stale' ? '旧目录，当前资格未确认' : '目录未知'}
        {account.collectedAt ? ` · ${new Date(account.collectedAt).toLocaleString()}` : ''}
      </div>)}</div>
      <div className="max-h-72 space-y-2 overflow-auto rounded-md border p-3">
        {catalog.models.length === 0 && <p className="text-xs text-muted-foreground">尚未取得可展示的订阅模型；已有平台模型配置不会被清空。</p>}
        {catalog.models.map((model) => {
          const eligible = catalog.accounts.filter((account) => model.eligibleCredentialRefs.includes(account.credentialRef)).map((account) => account.priority);
          const metadata = catalog.accounts.flatMap((account) => account.models.filter((entry) => entry.id === model.id).map((entry) => ({ ...entry, priority: account.priority, status: account.status })));
          return <label key={model.id} className="flex items-start gap-2 text-sm">
            <input className="mt-1" type="checkbox" checked={selection.includes(model.id)} disabled={readOnly || !eligible.length}
              onChange={(event) => setSelection((old) => event.target.checked ? [...new Set([...old, model.id])] : old.filter((id) => id !== model.id))} />
            <span><span className="font-medium">{model.name || model.id}</span><span className="ml-2 font-mono text-xs text-muted-foreground">{model.id}</span>
              <span className="block text-xs text-muted-foreground">{eligible.length ? `可用账号优先级：${eligible.join('、')}` : '资格待重新确认'}</span>
              {metadata.map((entry) => <span key={entry.priority} className="block text-xs text-muted-foreground">账号 {entry.priority}：窗口 {entry.contextWindow?.toLocaleString() ?? '未提供'}；思考深度 {entry.supportsReasoningEffort === undefined ? '未提供' : entry.supportsReasoningEffort ? '支持' : '不支持'}；图片 {entry.inputModalities === undefined ? '未提供' : entry.inputModalities.includes('image') ? '支持' : '不支持'}{entry.status !== 'fresh' ? '（旧信息）' : ''}</span>)}
            </span>
          </label>;
        })}
      </div>
      {!sameRevision && <div className="rounded-md border p-3 text-xs text-muted-foreground"><p>授权或其他平台配置已更新。请先重新载入模型配置，再导入；这不会覆盖其他管理员的模型改动。</p>
        <Button type="button" size="sm" variant="outline" className="mt-2" disabled={loading} onClick={() => { if (window.confirm('重新载入将放弃本页尚未保存的模型与辅助设置，确认刷新吗？')) void onRefreshModels(); }}>刷新模型配置</Button>
      </div>}
      <div className="flex flex-wrap items-center gap-2"><Label htmlFor="grok-import-group">导入目标</Label>
        <select id="grok-import-group" className="h-9 min-w-0 rounded-md border bg-card px-3 text-sm" value={target} disabled={readOnly} onChange={(event) => setTarget(event.target.value)}>
          <option value="__new__">新建 Grok 订阅分组（仅在点击导入时）</option>
          {groups.filter((group) => group.responses_transport === 'grok_subscription').map((group) => <option key={group.id} value={group.id}>{group.name || group.id}</option>)}
        </select>
        <Button type="button" size="sm" disabled={readOnly || loading || !sameRevision || !selection.length || state?.writePolicy?.canSave !== true} onClick={importModels}><Download className="size-3.5" />导入所选模型</Button>
      </div>
      <p className="text-xs text-muted-foreground">只导入已确认的共同能力；窗口未知时留空且不会据此开启自动压缩。目录不提供价格时不写入成本价，不能理解为免费。</p>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
''')
p=root/'index.tsx';s=p.read_text()
# Move stable pure editing helpers out of the large page, without altering their behavior.
a=s.index('function moveItem<T>');b=s.index('export function ModelManager()',a);helpers=s[a:b]
helpers=re.sub(r'(?m)^function ', 'export function ', helpers)
helpers=re.sub(r'(?m)^const (emptyModel|emptyGroup|emptyPricing|defaultMemoryIndex)',r'export const \1',helpers)
put('modelManagerEditing.ts', '''import type { ModelProtocol, ResponsesTransport, EditableGroup, EditableModel, EditableMemoryIndexConfig } from './modelConfigTypes';
export const DEFAULT_PROTOCOL: ModelProtocol = 'chat_completions';
export const INHERIT_PROTOCOL = '__inherit__';
'''+helpers)
exports=re.findall(r'export (?:function|const) (\w+)',helpers)
s=s[:a]+s[b:]
s=s.replace('const DEFAULT_PROTOCOL: ModelProtocol = "chat_completions";\nconst INHERIT_PROTOCOL = "__inherit__";\n','',1)
s='import { DEFAULT_PROTOCOL, INHERIT_PROTOCOL, '+', '.join(exports)+' } from "./modelManagerEditing";\n'+s
s='''import { GrokModelCatalogPicker } from './GrokModelCatalogPicker';
import { importGrokCatalogModels } from './grokCatalogImport';
import { changeGroupTransport, changeModelTransport, isSubscriptionTransport, subscriptionTransportNotice } from './subscriptionModelForm';
'''+s
# Replace only the transport editing functions with tested provider-neutral helpers.
a=s.index('  const updateGroupResponsesTransport = useCallback(');b=s.index('  const reorderGroup =',a)
s=s[:a]+'''  const updateGroupResponsesTransport = useCallback((groupId: string, transport: ResponsesTransport) => {
    updateModels((current) => ({ ...current, groups: current.groups.map((group) => group.id === groupId ? changeGroupTransport(group, transport) : group) }));
  }, [updateModels]);

'''+s[b:]
a=s.index('  const updateModelResponsesTransport = useCallback(');b=s.index('  const reorderModel =',a)
s=s[:a]+'''  const updateModelResponsesTransport = useCallback((groupId: string, modelId: string, transport: ResponsesTransport | "inherit") => {
    updateModels((current) => ({ ...current, groups: current.groups.map((group) => group.id === groupId
      ? { ...group, models: group.models.map((model) => model.id === modelId ? changeModelTransport(model, transport) : model) } : group) }));
  }, [updateModels]);

'''+s[b:]
s=s.replace('const selectedGroupDefaultIsCodex = selectedGroup?.responses_transport === "codex_subscription";', 'const selectedGroupDefaultIsSubscription = isSubscriptionTransport(selectedGroup?.responses_transport);',1)
s=s.replace('selectedGroupDefaultIsCodex','selectedGroupDefaultIsSubscription')
s=s.replace('selectedModelTransport === "codex_subscription"','isSubscriptionTransport(selectedModelTransport)')
s=s.replace('<option value="codex_subscription">Codex subscription OAuth</option>','<option value="codex_subscription">Codex subscription OAuth</option>\n                    <option value="grok_subscription">Grok 订阅 OAuth</option>')
s=s.replace('选择 Codex 后自动锁定 Responses、完整历史、稳定 cache key 与无状态调用。','订阅 transport 自动锁定 Responses 与完整历史。Grok 不使用 Codex 的 WebSocket 或 cache key。')
old='Codex 固定逻辑协议：`store:false`、每轮保留完整历史、禁止标准 HTTP `previous_response_id`、稳定 session cache key、encrypted reasoning replay。启用上方 WebSocket 接力后，只压缩线上发送内容；PostgreSQL 完整历史仍是事实源，异常会自动回退全量 HTTP/SSE。'
assert old in s;s=s.replace(old,'{subscriptionTransportNotice(selectedGroup.responses_transport)}',1)
# Match existing image helper selection without changing the global-default model dropdown.
needle='''{models.groups.flatMap((group) => group.models.map((model) => (
                        <option key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>{group.name}/{model.name}</option>
                      )))}''';assert needle in s
s=s.replace(needle,needle.replace('group.models.map(', 'group.models.filter((model) => resolveResponsesTransport(group, model) !== "grok_subscription").map('),1)
s=s.replace('主模型未声明 image 输入时，由该模型先看图并生成带来源标记的视觉摘要。','主模型未声明 image 输入时，由该模型先看图并生成带来源标记的视觉摘要。Grok 订阅暂不支持该独立辅助路径；主对话图片能力按订阅目录校验。',1)
s=s.replace('可选；主图片理解模型失败后按顺序尝试，使用 group/model 引用并以逗号分隔。','可选；主图片理解模型失败后按顺序尝试，使用 group/model 引用并以逗号分隔；不能填写 Grok 订阅模型。',1)
s=s.replace('仅用于平台成本统计，不是客户售价或积分倍率。留空表示继续使用内置成本价，未知模型 cost=0。','仅用于平台成本统计，不是客户售价或积分倍率。未知模型的账面 cost=0 仅表示未登记成本，不代表订阅免费，也不是上游实际扣款。',1)
# The explicit import updates only the draft; normal models.save still performs revision/confirmation.
needle='<GrokSubscriptionCard readOnly={accountReadOnly} />';assert needle in s
s=s.replace(needle,'''<GrokSubscriptionCard readOnly={accountReadOnly}>{(subscriptionState) => (
                <GrokModelCatalogPicker state={subscriptionState} groups={models.groups} readOnly={platformReadOnly || saving}
                  modelRevision={revision} onRefreshModels={refresh} onImport={(target, entries) => {
                    if (platformReadOnly || saving) throw new Error("当前模型配置不可写");
                    const result = importGrokCatalogModels(models, target, entries);
                    updateModels(() => result.models); return result.imported;
                  }} />
              )}</GrokSubscriptionCard>''',1)
# Provider-owned tool search is not a verified Grok capability; eager local functions are explicit.
s=s.replace('value={selectedGroup.mcp_loading_mode ?? "auto"}', 'disabled={selectedGroup.responses_transport === "grok_subscription"} value={selectedGroup.responses_transport === "grok_subscription" ? "eager" : (selectedGroup.mcp_loading_mode ?? "auto")}')
s=s.replace('value={selectedGroup.tool_search_protocol ?? "none"}', 'disabled={selectedGroup.responses_transport === "grok_subscription"} value={selectedGroup.responses_transport === "grok_subscription" ? "none" : (selectedGroup.tool_search_protocol ?? "none")}')
s=s.replace('value={selectedModelContext.model.mcp_loading_mode ?? "inherit"}', 'disabled={selectedModelTransport === "grok_subscription"} value={selectedModelTransport === "grok_subscription" ? "eager" : (selectedModelContext.model.mcp_loading_mode ?? "inherit")}')
s=s.replace('value={selectedModelContext.model.tool_search_protocol ?? "inherit"}', 'disabled={selectedModelTransport === "grok_subscription"} value={selectedModelTransport === "grok_subscription" ? "none" : (selectedModelContext.model.tool_search_protocol ?? "inherit")}')
# Explain model-level protocol constraints even when the group uses a different transport.
needle='当前生效：{selectedModelTransport}';s=s.replace(needle,needle+'\n                      {selectedModelTransport === "grok_subscription" ? "；HTTP/SSE，全量平台工具；思考深度与图像能力需订阅目录确认" : ""}',1)
p.write_text(s)
p=root/'GroupCredentialsFields.tsx';s=p.read_text();s=s.replace('Codex 使用已授权账号，自动采集套餐额度。API Key 与 Base URL 保留，但仅用于 API Key transport。','Codex / Grok 订阅使用各自的平台授权池，套餐额度按账号采集。API Key 与 Base URL 保留，但仅用于 API Key transport，Grok 不会回退到该计费路径。',1);p.write_text(s)
p=root/'UtilityModelSettings.tsx';s=p.read_text();s=s.replace('  protocol?: string;\n  models: { id: string; name: string; protocol?: string }[];', '  protocol?: string;\n  responses_transport?: string;\n  models: { id: string; name: string; protocol?: string; responses_transport?: string }[];',1)
s=s.replace("    protocol: model.protocol ?? group.protocol ?? 'chat_completions',", "    protocol: model.protocol ?? group.protocol ?? 'chat_completions',\n    transport: model.responses_transport ?? group.responses_transport,",1)
s=s.replace("model.protocol === 'chat_completions'", "model.protocol === 'chat_completions' && model.transport !== 'grok_subscription'",1);p.write_text(s)
# Runtime-side capability enforcement is not delegated to the browser.
p=Path('server/src/app/models.ts');s=p.read_text();needle='  if (toolSearchProtocol !== undefined) options.toolSearchProtocol = toolSearchProtocol;';assert needle in s
s=s.replace(needle,needle+"\n  if (responsesTransport === 'grok_subscription') { options.mcpLoadingMode = 'eager'; options.toolSearchProtocol = 'none'; options.disableResponseChaining = true; options.disablePromptCacheKey = true; }",1);p.write_text(s)
p=Path('server/src/app/subscriptionModelConfigValidation.ts');s=p.read_text();s=s.replace('responses_transport?: string','responses_transport?: string; mcp_loading_mode?: string; tool_search_protocol?: string')
needle="      if (!value[root])";assert needle in s
s=s.replace(needle,'''      if (transport === 'grok_subscription' && ((model.mcp_loading_mode ?? group.mcp_loading_mode) === 'deferred'
          || (model.tool_search_protocol ?? group.tool_search_protocol) === 'openai_responses_hosted')) ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['models', 'groups', groupIndex, 'models', modelIndex, 'mcp_loading_mode'],
        message: 'Grok 订阅尚未验证 hosted tool_search；请使用 eager/auto 与 tool_search_protocol=none，由平台执行完整函数列表。',
      });
'''+needle,1);p.write_text(s)
print('Applied Grok transport editing, explicit catalog import through models.save, conservative metadata and consistent auxiliary/tool-search capability limits')

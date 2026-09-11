import { useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { EditableGroup } from './modelConfigTypes';
import type { GrokSubscriptionState } from './subscriptionTypes';
import { GROK_ADMIN_API, readSubscriptionJson } from './grokSubscriptionClient';
import {
  catalogImportEntries,
  type GrokCatalogEntry,
  type GrokCatalogResponse,
} from './grokCatalogImport';
export function GrokModelCatalogPicker({
  state,
  groups,
  readOnly,
  modelRevision,
  onRefreshModels,
  onImport,
}: {
  state: GrokSubscriptionState | null;
  groups: EditableGroup[];
  readOnly: boolean;
  modelRevision: string;
  onRefreshModels: () => void | Promise<void>;
  onImport: (target: string, entries: GrokCatalogEntry[]) => number;
}) {
  const [catalog, setCatalog] = useState<GrokCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [target, setTarget] = useState('__new__');
  const [message, setMessage] = useState<string | null>(null);
  const sameRevision = !!modelRevision && modelRevision === state?.revision;
  const collect = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authFetch(`${GROK_ADMIN_API}/models?refresh=true`);
      const data = await readSubscriptionJson<GrokCatalogResponse>(response);
      if (
        !response.ok ||
        data.source !== 'subscription_catalog' ||
        !Array.isArray(data.models) ||
        !Array.isArray(data.accounts)
      )
        throw new Error(data.error ?? '订阅模型目录暂不可用。');
      setCatalog(data);
      setSelection((old) =>
        old.filter((id) =>
          data.models.some((model) => model.id === id && model.eligibleCredentialRefs.length),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '订阅目录采集失败；已配置模型保持不变。');
    } finally {
      setLoading(false);
    }
  };
  const importModels = () => {
    if (!catalog || readOnly || !sameRevision || state?.writePolicy?.canSave !== true) return;
    try {
      const count = onImport(target, catalogImportEntries(catalog, selection));
      setMessage(
        count
          ? `已将 ${count} 个模型加入待保存配置。请点击页面顶部“保存并生效”；默认模型和价格未改变。`
          : '所选模型已经存在，未重复添加。',
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型导入失败');
    }
  };
  return (
    <section className="space-y-3 border-t pt-3" aria-label="Grok 订阅模型目录">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">订阅模型目录</p>
          <p className="text-xs text-muted-foreground">
            逐账号采集资格；不会使用 Console API 目录代替订阅目录。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || !state?.config.enabled || !state.credentials.length}
          onClick={() => void collect()}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          采集订阅目录
        </Button>
      </div>
      {catalog && (
        <>
          <div className="space-y-1 text-xs text-muted-foreground">
            {catalog.accounts.map((account) => (
              <div key={account.credentialRef}>
                优先级 {account.priority}：
                {account.status === 'fresh'
                  ? `已确认 ${account.models.length} 个模型`
                  : account.status === 'stale'
                    ? '旧目录，当前资格未确认'
                    : '目录未知'}
                {account.collectedAt ? ` · ${new Date(account.collectedAt).toLocaleString()}` : ''}
              </div>
            ))}
          </div>
          <div className="max-h-72 space-y-2 overflow-auto rounded-md border p-3">
            {catalog.models.length === 0 && (
              <p className="text-xs text-muted-foreground">
                尚未取得可展示的订阅模型；已有平台模型配置不会被清空。
              </p>
            )}
            {catalog.models.map((model) => {
              const eligible = catalog.accounts
                .filter((account) => model.eligibleCredentialRefs.includes(account.credentialRef))
                .map((account) => account.priority);
              const metadata = catalog.accounts.flatMap((account) =>
                account.models
                  .filter((entry) => entry.id === model.id)
                  .map((entry) => ({
                    ...entry,
                    priority: account.priority,
                    status: account.status,
                  })),
              );
              return (
                <label key={model.id} className="flex items-start gap-2 text-sm">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={selection.includes(model.id)}
                    disabled={readOnly || !eligible.length}
                    onChange={(event) =>
                      setSelection((old) =>
                        event.target.checked
                          ? [...new Set([...old, model.id])]
                          : old.filter((id) => id !== model.id),
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">{model.name || model.id}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{model.id}</span>
                    <span className="block text-xs text-muted-foreground">
                      {eligible.length
                        ? `可用账号优先级：${eligible.join('、')}`
                        : '资格待重新确认'}
                    </span>
                    {metadata.map((entry) => (
                      <span key={entry.priority} className="block text-xs text-muted-foreground">
                        账号 {entry.priority}：窗口{' '}
                        {entry.contextWindow?.toLocaleString() ?? '未提供'}；思考深度{' '}
                        {entry.supportsReasoningEffort === undefined
                          ? '未提供'
                          : entry.supportsReasoningEffort
                            ? '支持'
                            : '不支持'}
                        ；图片{' '}
                        {entry.inputModalities === undefined
                          ? '未提供'
                          : entry.inputModalities.includes('image')
                            ? '支持'
                            : '不支持'}
                        {entry.status !== 'fresh' ? '（旧信息）' : ''}
                      </span>
                    ))}
                  </span>
                </label>
              );
            })}
          </div>
          {!sameRevision && (
            <div className="rounded-md border p-3 text-xs text-muted-foreground">
              <p>
                授权或其他平台配置已更新。请先重新载入模型配置，再导入；这不会覆盖其他管理员的模型改动。
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={loading}
                onClick={() => {
                  if (window.confirm('重新载入将放弃本页尚未保存的模型与辅助设置，确认刷新吗？'))
                    void onRefreshModels();
                }}
              >
                刷新模型配置
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="grok-import-group">导入目标</Label>
            <select
              id="grok-import-group"
              className="h-9 min-w-0 rounded-md border bg-card px-3 text-sm"
              value={target}
              disabled={readOnly}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="__new__">新建 Grok 订阅分组（仅在点击导入时）</option>
              {groups
                .filter((group) => group.responses_transport === 'grok_subscription')
                .map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name || group.id}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              size="sm"
              disabled={
                readOnly ||
                loading ||
                !sameRevision ||
                !selection.length ||
                state?.writePolicy?.canSave !== true
              }
              onClick={importModels}
            >
              <Download className="size-3.5" />
              导入所选模型
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            只导入已确认的共同能力；窗口未知时留空且不会据此开启自动压缩。目录不提供价格时不写入成本价，不能理解为免费。
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}

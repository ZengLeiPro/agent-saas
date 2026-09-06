import type { WebToolsSearchSourceConfig } from '@agent/shared/lib/toolControlsApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/contexts/AuthContext';
import type { ToolDetailPanelProps } from './ToolDetailPanel';

const PROVIDERS = [
  {
    value: 'volcengine',
    label: '火山豆包搜索（支持 Agent Plan）',
    endpoint: 'https://open.feedcoopapi.com/search_api/web_search',
  },
  {
    value: 'brave',
    label: 'Brave Search',
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
  },
  {
    value: 'tencent_wsa',
    label: '腾讯云联网搜索',
    endpoint: 'https://api.wsa.cloud.tencent.com/SearchPro',
  },
  {
    value: 'zhipu',
    label: '智谱搜索',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
  },
  { value: 'tavily', label: 'Tavily', endpoint: 'https://api.tavily.com/search' },
] as const;

export function WebSearchParamsSection(props: ToolDetailPanelProps): JSX.Element {
  const { platformReadOnly } = useAuth();
  const search = props.webToolsDraft.search ?? {};
  const disabled = platformReadOnly || props.settingsSaving;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">搜索源配置</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          国内与境外搜索按请求范围选用；已配置两个源时，失败可自动尝试另一个源。保存后对后续运行生效。
        </p>
        <SourceFields
          id="cn"
          label="国内搜索源"
          source={search}
          disabled={disabled}
          apiKey={props.searchApiKeyText}
          onKeyChange={(value) => {
            props.setSearchApiKeyText(value);
            props.markDirty();
          }}
          onChange={props.updateSearch}
        />
        <div className="flex items-center justify-between">
          <Label htmlFor="global-search-enabled">独立配置境外搜索源</Label>
          <Switch
            id="global-search-enabled"
            checked={!!search.global}
            disabled={disabled}
            onCheckedChange={(checked) =>
              props.updateSearch({ global: checked ? { provider: 'brave' } : null })
            }
          />
        </div>
        {search.global && (
          <SourceFields
            id="global"
            label="境外搜索源"
            source={search.global}
            disabled={disabled}
            apiKey={search.global.apiKey ?? ''}
            onKeyChange={(apiKey) => props.updateSearch({ global: { ...search.global, apiKey } })}
            onChange={(patch) => props.updateSearch({ global: { ...search.global, ...patch } })}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SourceFields({
  id,
  label,
  source,
  apiKey,
  onKeyChange,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  source: WebToolsSearchSourceConfig;
  apiKey: string;
  disabled: boolean;
  onKeyChange: (value: string) => void;
  onChange: (patch: Partial<WebToolsSearchSourceConfig>) => void;
}): JSX.Element {
  const provider = source.provider ?? 'volcengine';
  const option = PROVIDERS.find((entry) => entry.value === provider)!;
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-3 text-sm font-medium">{label}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-provider`}>搜索服务</Label>
          <Select
            value={provider}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === provider) return;
              onKeyChange('');
              onChange({
                provider: value as typeof provider,
                endpoint: undefined,
                apiKey: undefined,
                apiKeyRef: undefined,
                hasApiKey: false,
                searchEngine: undefined,
                searchDepth: undefined,
                enableWaiting: undefined,
                maxWaitTimeMs: undefined,
              });
            }}
          >
            <SelectTrigger id={`${id}-provider`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-key`}>API Key</Label>
          <Input
            id={`${id}-key`}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            placeholder={
              source.hasApiKey || source.apiKeyRef ? '已配置，留空保留' : '输入搜索服务的 API Key'
            }
            onChange={(event) => onKeyChange(event.target.value)}
          />
        </div>
        <NumberField
          id={`${id}-timeout`}
          label="请求总超时（毫秒）"
          value={source.timeoutMs}
          placeholder={provider === 'volcengine' ? '15000' : '8000'}
          max={60_000}
          onChange={(timeoutMs) => onChange({ timeoutMs })}
        />
        <NumberField
          id={`${id}-count`}
          label="结果数（默认值及上限）"
          value={source.maxResults}
          placeholder="5"
          max={10}
          onChange={(maxResults) => onChange({ maxResults })}
        />
      </div>
      {provider === 'volcengine' && (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            使用 Agent Plan 专属 Key，并在火山控制台「使用配置 → 配置
            Harness」开启豆包搜索抵扣。账号每月共享 500 次免费额度，耗尽后 5
            AFP/次，实际扣减以火山账单为准。
          </p>
          <div className="flex items-center justify-between">
            <Label htmlFor={`${id}-waiting`}>超出限流时服务端排队</Label>
            <Switch
              id={`${id}-waiting`}
              checked={source.enableWaiting !== false}
              disabled={disabled}
              onCheckedChange={(enableWaiting) => onChange({ enableWaiting })}
            />
          </div>
          {source.enableWaiting !== false && (
            <NumberField
              id={`${id}-wait-time`}
              label="最长排队等待（毫秒）"
              value={source.maxWaitTimeMs}
              placeholder="5000"
              max={10_000}
              onChange={(maxWaitTimeMs) => onChange({ maxWaitTimeMs })}
            />
          )}
        </>
      )}
      {provider === 'zhipu' && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-engine`}>搜索引擎</Label>
          <Input
            id={`${id}-engine`}
            value={source.searchEngine ?? ''}
            placeholder="search_std"
            onChange={(event) => onChange({ searchEngine: event.target.value || undefined })}
          />
        </div>
      )}
      {provider === 'tavily' && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-depth`}>搜索深度</Label>
          <Select
            value={source.searchDepth ?? 'basic'}
            disabled={disabled}
            onValueChange={(value) => onChange({ searchDepth: value as 'basic' | 'advanced' })}
          >
            <SelectTrigger id={`${id}-depth`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="basic">基础</SelectItem>
              <SelectItem value="advanced">深入</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">高级配置</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-endpoint`}>接口地址</Label>
            <Input
              id={`${id}-endpoint`}
              value={source.endpoint ?? ''}
              placeholder={option.endpoint}
              onChange={(event) => onChange({ endpoint: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-key-ref`}>凭据引用</Label>
            <Input
              id={`${id}-key-ref`}
              value={source.apiKeyRef ?? ''}
              placeholder="使用已有凭据时填写"
              onChange={(event) => onChange({ apiKeyRef: event.target.value })}
            />
          </div>
        </div>
      </details>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  value,
  placeholder,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value?: number;
  placeholder: string;
  max: number;
  onChange: (value: number | undefined) => void;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={1}
        max={max}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) =>
          onChange(event.target.value === '' ? undefined : Number(event.target.value))
        }
      />
    </div>
  );
}

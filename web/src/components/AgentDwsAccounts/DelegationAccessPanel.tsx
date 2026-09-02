import { useState } from 'react';
import type { AgentDwsAccount } from '@agent/shared';

import { OrganizationResourceAssignmentEditor } from '@/components/OrganizationGovernance/ResourceAccessEditors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { authFetch } from '@/lib/authFetch';

interface DelegationResourceResponse {
  resourceId: string;
  args: string[];
  error?: string;
}

export function DelegationAccessPanel({
  tenantId,
  accounts,
}: {
  tenantId: string;
  accounts: AgentDwsAccount[];
}) {
  const activeAccounts = accounts.filter(
    (account) => account.status === 'active' && account.profileId,
  );
  const [accountId, setAccountId] = useState('');
  const [argsText, setArgsText] = useState('["calendar", "event", "list"]');
  const [resourceId, setResourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const resolve = async () => {
    setBusy(true);
    setError('');
    setResourceId('');
    try {
      const value = JSON.parse(argsText) as unknown;
      if (
        !Array.isArray(value) ||
        !value.length ||
        !value.every((item) => typeof item === 'string' && item.length > 0)
      ) {
        throw new Error('命令参数必须是非空 JSON 字符串数组');
      }
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/delegation-resource?tenantId=${encodeURIComponent(tenantId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args: value }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as DelegationResourceResponse;
      if (!response.ok) throw new Error(data.error || '生成委托资源失败');
      setResourceId(data.resourceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>钉钉命令委托授权</CardTitle>
        <CardDescription>
          委托权限按“账号 + 完整 DWS 命令参数”精确绑定，禁止使用账号级宽泛授权。先生成稳定资源
          ID，再通过 Assignment 配置成员、群组或智能体。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="dws-delegation-account">已授权账号</Label>
            <select
              id="dws-delegation-account"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
                setResourceId('');
              }}
            >
              <option value="">请选择账号</option>
              {activeAccounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.displayName} · {account.accountId}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dws-delegation-args">完整命令参数 JSON</Label>
            <Textarea
              id="dws-delegation-args"
              value={argsText}
              onChange={(event) => {
                setArgsText(event.target.value);
                setResourceId('');
              }}
              placeholder='["calendar", "event", "list"]'
            />
          </div>
        </div>
        <Button variant="outline" disabled={busy || !accountId} onClick={() => void resolve()}>
          生成精确委托资源
        </Button>
        {!activeAccounts.length ? (
          <div className="text-sm text-muted-foreground">暂无完成 OAuth 且处于启用状态的账号。</div>
        ) : null}
        {error ? (
          <div role="alert" className="text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {resourceId ? (
          <>
            <div className="break-all rounded-md bg-muted p-3 font-mono text-xs">{resourceId}</div>
            <OrganizationResourceAssignmentEditor
              tenantId={tenantId}
              resourceType="dws_delegation"
              resourceId={resourceId}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

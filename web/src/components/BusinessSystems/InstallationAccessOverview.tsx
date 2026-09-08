import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { installationPath } from '@/lib/kyAppManagementApi';
import { businessStatusLabel } from './presentation';
import { ResourceState, useManagementResource } from './ManagementResource';

interface AccessOverview {
  summary: {
    effectiveUserCount: number;
    effectiveAgentCount: number;
    pendingPersonalAuthorizationCount: number;
    ruleCount: number;
  };
  users: Array<{
    userId: string;
    displayName: string;
    username: string;
    departmentNames: string[];
    accessSources: string[];
    personalAuthorizationStatus: string;
    agentCapabilityStatus: string;
  }>;
  agents: Array<{ agentId: string; name: string; source: string; capabilityStatus: string }>;
  nextCursor: string | null;
}

export function InstallationAccessOverview({ installationId }: { installationId: string }) {
  const [kind, setKind] = useState<'user' | 'agent'>('user');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const resource = useManagementResource<AccessOverview>(
    `${installationPath(installationId, '/access-overview')}?${new URLSearchParams({ kind, ...(appliedQuery ? { query: appliedQuery } : {}) })}`,
  );
  return (
    <section className="space-y-3 rounded border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">有效授权清单</h3>
          <p className="text-xs text-muted-foreground">
            展示规则计算后的最终结果，不包含被排除的成员或智能体。
          </p>
        </div>
        <div className="flex gap-2" role="tablist" aria-label="授权对象">
          <Button
            size="sm"
            role="tab"
            aria-selected={kind === 'user'}
            variant={kind === 'user' ? 'default' : 'outline'}
            onClick={() => setKind('user')}
          >
            成员
          </Button>
          <Button
            size="sm"
            role="tab"
            aria-selected={kind === 'agent'}
            variant={kind === 'agent' ? 'default' : 'outline'}
            onClick={() => setKind('agent')}
          >
            智能体
          </Button>
        </div>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedQuery(query.trim());
        }}
      >
        <Input
          aria-label="搜索授权对象"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索姓名或账号"
        />
        <Button type="submit" variant="outline">
          搜索
        </Button>
      </form>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            已授权成员 {resource.data.summary.effectiveUserCount} 人 · 已授权智能体{' '}
            {resource.data.summary.effectiveAgentCount} 个
          </p>
          {kind === 'user' ? (
            resource.data.users.length === 0 ? (
              <p>尚未授权任何成员或 Agent</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>所属部门</th>
                      <th>获得权限的原因</th>
                      <th>个人授权</th>
                      <th>Agent 能力</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resource.data.users.map((item) => (
                      <tr className="border-t" key={item.userId}>
                        <td className="py-2">
                          {item.displayName}
                          <div className="text-xs text-muted-foreground">{item.username}</div>
                        </td>
                        <td>{item.departmentNames.join('、') || '未分组'}</td>
                        <td>{item.accessSources.map(businessStatusLabel).join('、')}</td>
                        <td>{businessStatusLabel(item.personalAuthorizationStatus)}</td>
                        <td>{businessStatusLabel(item.agentCapabilityStatus)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : resource.data.agents.length === 0 ? (
            <p>尚未授权任何成员或 Agent</p>
          ) : (
            <ul className="divide-y">
              {resource.data.agents.map((item) => (
                <li className="flex items-center justify-between py-2 text-sm" key={item.agentId}>
                  <span>{item.name}</span>
                  <span>
                    {businessStatusLabel(item.source)} ·{' '}
                    {businessStatusLabel(item.capabilityStatus)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

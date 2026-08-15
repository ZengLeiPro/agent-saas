import { Label } from '@/components/ui/label';
import type { OrgAgentFormValues } from './types';

type AudiencePatch = Partial<Pick<
  OrgAgentFormValues,
  'audienceExposure' | 'audienceUserIds' | 'audienceGroupIds'
>>;

export function OrgAgentAudienceSection({
  values,
  tenantUsers,
  directoryGroups,
  directoryGroupsError,
  onChange,
}: {
  values: Pick<OrgAgentFormValues, 'audienceExposure' | 'audienceUserIds' | 'audienceGroupIds'>;
  tenantUsers: Array<{ id: string; username: string; realName?: string }>;
  directoryGroups: Array<{ groupId: string; displayName: string }>;
  directoryGroupsError: string;
  onChange: (patch: AudiencePatch) => void;
}) {
  const toggleInList = (list: string[], value: string, checked: boolean): string[] =>
    checked ? Array.from(new Set([...list, value])) : list.filter(item => item !== value);

  return (
    <div className="space-y-1.5 rounded-xl border p-4">
      <Label>访问范围</Label>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={values.audienceExposure === 'all'} onChange={() => onChange({ audienceExposure: 'all' })} />
          全员可用
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={values.audienceExposure === 'allow_users'} onChange={() => onChange({ audienceExposure: 'allow_users' })} />
          仅指定成员或部门
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={values.audienceExposure === 'deny_users'} onChange={() => onChange({ audienceExposure: 'deny_users' })} />
          排除指定成员或部门
        </label>
      </div>
      {values.audienceExposure !== 'all' ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="text-xs font-medium">成员</div>
            {tenantUsers.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">当前组织暂无成员。</div>
            ) : (
              <div className="grid max-h-40 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
                {tenantUsers.map(user => (
                  <label key={user.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={values.audienceUserIds.includes(user.id)}
                      onChange={event => onChange({
                        audienceUserIds: toggleInList(values.audienceUserIds, user.id, event.target.checked),
                      })}
                    />
                    <span className="truncate">{user.realName || user.username}
                      <span className="ml-1 text-xs text-muted-foreground">{user.username}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium">部门 / 钉钉目录组</div>
            {directoryGroupsError ? (
              <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning-ink">{directoryGroupsError}</div>
            ) : directoryGroups.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">暂无可用目录组。</div>
            ) : (
              <div className="grid max-h-40 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
                {directoryGroups.map(group => (
                  <label key={group.groupId} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={values.audienceGroupIds.includes(group.groupId)}
                      onChange={event => onChange({
                        audienceGroupIds: toggleInList(values.audienceGroupIds, group.groupId, event.target.checked),
                      })}
                    />
                    <span className="truncate">{group.displayName}<span className="ml-1 text-xs text-muted-foreground">{group.groupId}</span></span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

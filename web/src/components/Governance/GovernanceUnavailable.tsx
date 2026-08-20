import { TriangleAlert, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface GovernanceUnavailableProps {
  error?: Error | string | null;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

/** Fail-closed state: an API failure is never presented as an access grant. */
export function GovernanceUnavailable({
  error,
  onRetry,
  retrying = false,
  className = '',
}: GovernanceUnavailableProps) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    && typeof error.status === 'number' ? error.status : undefined;
  const accessDenied = status === 403;

  return (
    <section
      className={`rounded-lg border border-danger/30 bg-danger-subtle p-4 text-danger-ink ${className}`}
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{accessDenied ? '权限不足' : '权限服务暂不可用'}</h3>
          <p className="mt-1 text-sm">
            {accessDenied
              ? '当前账号没有访问此治理页面的权限，请联系组织管理员或平台管理员。'
              : '当前无法获取权威权限判定。系统已停止敏感操作，但这不代表当前账号缺少权限，请稍后重试。'}
          </p>
          {status ? <p className="mt-2 text-xs opacity-80">服务状态：{status}</p> : null}
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={onRetry}
              disabled={retrying}
            >
              <RotateCcw aria-hidden="true" />
              {retrying ? '正在重试' : '重试权威判定'}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

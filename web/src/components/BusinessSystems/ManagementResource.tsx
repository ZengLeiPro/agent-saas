import { useEffect, useState } from 'react';
import { kyAppRequest } from '@/lib/kyAppManagementApi';
import { Button } from '@/components/ui/button';

/** 请求结果携带所属路径；组织切换的首帧也不能展示旧组织数据。 */
export function useManagementResource<T>(path: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>({ path: '' });
  useEffect(() => {
    const controller = new AbortController();
    kyAppRequest<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ path, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ path, error: error instanceof Error ? error.message : '读取失败' });
      });
    return () => controller.abort();
  }, [path, revision]);
  return {
    data: state.path === path ? state.data : undefined,
    error: state.path === path ? state.error : undefined,
    reload: () => {
      setState({ path: '' });
      setRevision((value) => value + 1);
    },
  };
}
export function ResourceState({ error, retry }: { error?: string; retry: () => void }) {
  return (
    <div role={error ? 'alert' : 'status'} className="p-4 text-sm text-muted-foreground">
      {error ?? '正在加载…'}
      {error && (
        <Button variant="outline" onClick={retry}>
          重试
        </Button>
      )}
    </div>
  );
}

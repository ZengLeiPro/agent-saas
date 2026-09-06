/**
 * 订阅壳内安装实例单一来源（`lib/mySystemsSource.ts`）。
 *
 * 左栏入口与 AppHost 共用同一份快照，壳内只发一次 `GET /api/systems/mine`。
 */
import { useCallback, useEffect, useState } from 'react';

import {
  getMySystemsSnapshot,
  loadMySystems,
  subscribeMySystems,
  type MySystemsSnapshot,
} from '@/lib/mySystemsSource';

export interface UseMySystemsResult extends MySystemsSnapshot {
  /** 重新拉取（重试按钮、`perm.changed`、`route.result{forbidden}`）。 */
  reload: () => void;
}

export function useMySystems(): UseMySystemsResult {
  const [snapshot, setSnapshot] = useState<MySystemsSnapshot>(getMySystemsSnapshot);

  useEffect(() => {
    const unsubscribe = subscribeMySystems(setSnapshot);
    // 订阅之后再触发，否则首次结果可能落在订阅之前
    setSnapshot(getMySystemsSnapshot());
    void loadMySystems().catch(() => {
      /* 失败态已经通过快照广播出去了 */
    });
    return unsubscribe;
  }, []);

  const reload = useCallback(() => {
    void loadMySystems({ force: true }).catch(() => {
      /* 同上 */
    });
  }, []);

  return { ...snapshot, reload };
}

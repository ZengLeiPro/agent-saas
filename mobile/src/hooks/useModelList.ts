import { useEffect, useState } from 'react';
import type { ModelList } from '@agent/shared';
import { authFetch } from '@agent/shared';

let cachedModelList: ModelList | null = null;

export function useModelList() {
  const [modelList, setModelList] = useState<ModelList | null>(cachedModelList);

  useEffect(() => {
    if (cachedModelList) return;
    authFetch('/api/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          cachedModelList = data as ModelList;
          setModelList(cachedModelList);
        }
      })
      .catch(() => {});
  }, []);

  return modelList;
}

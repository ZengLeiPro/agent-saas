import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ModelList } from '../types/models';

/**
 * 模型列表与当前选中模型（两端 `useChatAppState` 共同内核）：
 * 拉 `/api/models`，成功后写入列表并按平台 `selectOnLoad` 规则决定选中项；
 * 何时拉（挂载 / 登录 / WS 重连 / 默认模型变更事件）与会话切换时的恢复策略留在平台。
 */
export interface ModelSelectionOptions {
  authFetch: (url: string) => Promise<Response>;
  /** 列表到达时的选中规则：入参为当前选中值与新列表。 */
  selectOnLoad: (previous: string | null, list: ModelList) => string;
}

export interface ModelSelection {
  modelList: ModelList | null;
  selectedModel: string | null;
  setSelectedModel: Dispatch<SetStateAction<string | null>>;
  /** 与 `modelList` 同步的 ref，供事件回调判断是否已有列表。 */
  modelListRef: MutableRefObject<ModelList | null>;
  /** 与 `selectedModel` 同步的 ref，供发送时读取。 */
  selectedModelRef: MutableRefObject<string | null>;
  fetchModelList: () => void;
}

export function useModelSelection(options: ModelSelectionOptions): ModelSelection {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const modelListRef = useRef(modelList);
  modelListRef.current = modelList;
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const fetchModelList = useCallback(() => {
    optionsRef.current
      .authFetch('/api/models')
      .then((r) => (r.ok ? (r.json() as Promise<ModelList>) : null))
      .then((data) => {
        if (data) {
          setModelList(data);
          setSelectedModel((prev) => optionsRef.current.selectOnLoad(prev, data));
        }
      })
      .catch(() => {});
  }, []);

  return {
    modelList,
    selectedModel,
    setSelectedModel,
    modelListRef,
    selectedModelRef,
    fetchModelList,
  };
}

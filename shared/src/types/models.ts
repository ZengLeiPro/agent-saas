export interface ModelItem {
  id: string;
  name: string;
  description?: string;
  recommended?: boolean;
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelItem[];
}

export interface ModelList {
  groups: ModelGroup[];
  default: string; // "groupId/modelId"
  allowCrossGroupSwitch: boolean;
  showGroupNames: boolean;
  /** 是否向当前组织成员显示顶部上下文/Token 统计（租户策略，缺省 true）。 */
  showContextTokens: boolean;
}

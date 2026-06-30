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
}

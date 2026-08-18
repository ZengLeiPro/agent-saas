export interface ModelItem {
  id: string;
  name: string;
  description?: string;
  recommended?: boolean;
  /** 平台配置中的原始展示名（未被租户 displayOverrides 覆盖），组织控制台别名编辑时用于参照。 */
  originalName?: string;
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelItem[];
  /** 平台配置中的原始分组展示名（未被租户 displayOverrides 覆盖），组织控制台别名编辑时用于参照。 */
  originalName?: string;
}

export interface ModelList {
  groups: ModelGroup[];
  default: string; // "groupId/modelId"
  allowCrossGroupSwitch: boolean;
  showGroupNames: boolean;
  /** 是否向当前组织成员显示顶部上下文/Token 统计（租户策略，缺省 true）。 */
  showContextTokens: boolean;
  /** 是否允许当前组织成员点击展开上下文/Token 明细（租户策略，缺省 false）。 */
  allowContextTokenDetails: boolean;
}

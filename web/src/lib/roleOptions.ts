/**
 * 岗位选项：与场景库 scenario-library-v1.json 的 roles.name 对齐。
 * 用户资料写入这些值后，可被场景库岗位匹配逻辑稳定识别。
 */
export const ROLE_POSITION_OPTIONS = [
  "老板/总经理",
  "销售",
  "跟单/客服",
  "采购",
  "财务",
  "人事行政",
  "市场/电商运营",
  "生产计划",
] as const;

export type RolePositionOption = (typeof ROLE_POSITION_OPTIONS)[number];

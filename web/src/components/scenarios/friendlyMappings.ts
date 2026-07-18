import type {
  DataDependencyLevel,
  DataSourceDifficulty,
  HumanAuditPolicy,
  IndustryType,
  PushChannel,
  PushTarget,
  SkillLevel,
} from "@agent/shared";

export const friendlyDataDependency: Record<DataDependencyLevel, string> = {
  zero: "零输入",
  upload: "只需上传",
  ding: "需要授权钉钉能力",
  internal_system: "需要接入业务系统",
};

export const friendlyDataSourceDifficulty: Record<DataSourceDifficulty, string> = {
  zero: "无需配置",
  self_service_lt_30min: "自服务 30 分钟内可开",
  self_service_1_3_days: "自服务 1-3 天",
  field_engineering_1_2_weeks: "需要工程接入 1-2 周",
  field_assessment_gt_2_weeks: "需现场评估 2 周以上",
};

export const friendlySkillLevel: Record<SkillLevel, string> = {
  tenant: "公司规范",
  user: "个人偏好",
  platform: "平台默认",
};

export const friendlyHumanAuditPolicy: Record<HumanAuditPolicy, string> = {
  ai_draft_human_review_human_send: "AI 起草，您审核后发送",
  ai_draft_human_review_ai_send: "AI 起草，您确认后自动发送",
  ai_auto_no_audit_forbidden: "必须人工确认后发送",
};

export const friendlyPushChannel: Record<PushChannel, string> = {
  ding_work_notification: "钉钉工作通知",
  ding_group: "钉钉群",
  ding_both: "工作通知 + 群双落",
};

export const friendlyPushTarget: Record<PushTarget, string> = {
  self: "发给我",
  manager: "发给主管确认",
  group: "发到团队群",
};

export const friendlyIndustry: Record<IndustryType, string> = {
  manufacturing: "制造",
  trade: "贸易",
  retail: "零售",
  service: "服务",
  export: "出口",
  ecommerce: "电商",
};

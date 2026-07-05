/**
 * 场景库（Scenario Library）类型定义 · v2
 *
 * 数据源为 server 侧随代码发布的静态 JSON（server/src/data/scenarios/），
 * 经 GET /api/scenarios 下发。内部字段 source / enabled / salesPitch 必须由
 * 服务端剥离；客户面类型 ScenarioItem 不包含 salesPitch。
 */

export type ScenarioMode = "recurring" | "oneshot";

export type ScenarioRequirement =
  | "web"
  | "dingtalk"
  | "internal_system"
  | "upload";

export type IndustryType =
  | "manufacturing"
  | "trade"
  | "retail"
  | "service"
  | "export"
  | "ecommerce";

export type FirstAhaMode =
  | "zero_input_example"
  | "paste_then_result"
  | "upload_then_result"
  | "voice_then_result";

export type DataDependencyLevel =
  | "zero"
  | "upload"
  | "ding"
  | "internal_system";

export type PushChannel =
  | "ding_work_notification"
  | "ding_group"
  | "ding_both";

export type PushTarget = "self" | "manager" | "group";

export type HumanAuditPolicy =
  | "ai_draft_human_review_human_send"
  | "ai_draft_human_review_ai_send"
  | "ai_auto_no_audit_forbidden";

export type SkillLevel = "tenant" | "user" | "platform";

export type DataSourceDifficulty =
  | "zero"
  | "self_service_lt_30min"
  | "self_service_1_3_days"
  | "field_engineering_1_2_weeks"
  | "field_assessment_gt_2_weeks";

export type RetentionDay = "D1" | "D2" | "D3" | "D5" | "D7";
export type Day1PathStage = "T+0-30min" | "T+30min-1h" | "T+1h-4h";

export interface ScenarioRole {
  id: string;
  /** 岗位显示名，如「老板/总经理」 */
  name: string;
  /** 展示排序，越小越靠前 */
  sort: number;
  roleWelcomeMessage?: string | RoleWelcomeMessage;
  roleTopPains?: string[];
  roleP0DataSources?: RoleP0DataSource[];
  defaultRecurringId?: string | string[];
  demoIndustryTag?: DemoIndustryTag[];
  retentionPath7Day?: RetentionPath7DayItem[];
}

export interface RoleWelcomeMessage {
  default?: string;
  internal?: string;
  export?: string;
}

export interface RoleP0DataSource {
  name: string;
  difficulty: DataSourceDifficulty;
  afterConnected: string;
  customerAction: string;
}

export interface DemoIndustryTag {
  industry: IndustryType;
  sampleScenarioId: string;
}

export interface RetentionPath7DayItem {
  day: RetentionDay;
  mainlineAiAction: string;
  backupCsmAction?: string;
  sellUpBanned: boolean;
}

export interface ScenarioSlot {
  key: string;
  label: string;
  example: string;
}

export interface Day1PathStep {
  stage: Day1PathStage;
  userAction: string;
  aiAction: string;
  userSees: string;
}

export interface SalesPitch {
  oralScript: string;
  demoSteps: string[];
  bossQnA: SalesPitchBossQnA[];
}

export interface SalesPitchBossQnA {
  q: string;
  a: string;
}

export interface SkillCandidate {
  name: string;
  level: SkillLevel;
  firstSampleGate: string;
  freshnessMechanism: string;
  roiVisibility: string;
}

export interface ActivationFallback {
  withoutData: string;
  degradedContent: string;
}

export interface SignalAdaptation {
  dailyEmptyStreakToWeekly: number;
  userNoOpenStreakToPause: number;
  emptyContentFallback: string;
}

export interface PushSlot {
  channel: PushChannel;
  target: PushTarget;
  humanReviewRequired: boolean;
}

/** 单条预置场景（API 下发的公开形态，不含 source/enabled/salesPitch 内部字段） */
export interface ScenarioItem {
  id: string;
  title: string;
  role: string;
  industries: string[];
  mode: ScenarioMode;
  pitch: string;
  story: string;
  promptTemplate: string;
  slots: ScenarioSlot[];
  requires: ScenarioRequirement[];
  recommendCron: boolean;
  welcomeMessage?: string;
  day1PathSteps?: Day1PathStep[];
  cannotPromise?: string[];
  skillCandidates?: SkillCandidate[];
  industryFocus?: IndustryType[];
  dataDependencyLevel?: DataDependencyLevel;
  activationFallback?: ActivationFallback;
  signalAdaptation?: SignalAdaptation;
  pushSlot?: PushSlot;
  humanAuditPolicy?: HumanAuditPolicy;
  firstAhaMode?: FirstAhaMode;
}

export interface ScenarioItemInternal extends ScenarioItem {
  source?: string;
  enabled?: boolean;
  salesPitch?: SalesPitch;
}

export interface ScenarioLibraryFile {
  $schema?: string;
  version: 1 | 2;
  updatedAt: string;
  roles: ScenarioRole[];
  scenarios: ScenarioItemInternal[];
}

export interface ScenarioLibraryResponse {
  roles: ScenarioRole[];
  scenarios: ScenarioItem[];
}

/**
 * 把 promptTemplate 中的 {{key}} 槽位替换为对应 slot 的示例值，
 * 生成可直接预填进聊天输入框的完整起手 prompt（用户可再编辑后发送）。
 */
export function buildScenarioPrompt(
  scenario: Pick<ScenarioItem, "promptTemplate" | "slots">,
): string {
  let text = scenario.promptTemplate;
  for (const slot of scenario.slots) {
    // split/join 而非 RegExp，避免 key 中的特殊字符被当作正则元字符
    text = text.split(`{{${slot.key}}}`).join(slot.example);
  }
  return text;
}

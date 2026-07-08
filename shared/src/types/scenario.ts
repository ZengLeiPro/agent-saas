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

/**
 * 示例结果的数据来源标签。
 * synthetic：完全虚构的示例数据；desensitized：真实数据脱除标识后的示例数据；
 * public：来自公开渠道的数据。P0 批次全部为 synthetic。
 */
export type ScenarioExampleDataLabel = "synthetic" | "desensitized" | "public";

/**
 * 黄金静态示例结果：点场景卡即可秒开的预生成高质量示例交付物。
 * 不跑模型、不写记忆，客户面字段（服务端不剥离，需过 sanitize）。
 */
export interface ScenarioExampleResult {
  /** 完整示例交付物，markdown。内部按三段组织：示例结论 / AI 做了什么 / 换成你的资料需要什么 */
  body: string;
  /** 数据来源标签，本批全部 synthetic */
  dataLabel: ScenarioExampleDataLabel;
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
  /** 预生成的黄金示例结果；缺省表示该场景暂无静态示例（前端维持原有交互） */
  exampleResult?: ScenarioExampleResult;
  /** 真实 demo 会话的公开分享 token；存在时「看示例结果」直接进入只读回放页 */
  demoShareToken?: string;
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

/**
 * 场景库（Scenario Library）类型定义
 *
 * 场景库是按岗位分组的预置场景卡片库，用于解决新用户冷启动空白问题：
 * 用户浏览卡片 → 点「试一试」→ 新建会话并把起手 prompt 预填进输入框。
 *
 * 数据源为 server 侧随代码发布的静态 JSON（server/src/data/scenarios/），
 * 经 GET /api/scenarios 下发。注意：JSON 原始数据中的 `source`（内部溯源）
 * 与 `enabled`（上架开关）字段由服务端剥离/消费，不出现在本公开类型中。
 */

/** 场景形态：recurring = 常驻（可配定时任务持续跑）；oneshot = 一次性任务 */
export type ScenarioMode = "recurring" | "oneshot";

/** 场景运行的前置依赖 */
export type ScenarioRequirement =
  /** 需要联网检索 */
  | "web"
  /** 需要钉钉推送/协作 */
  | "dingtalk"
  /** 需要管理员配置内部系统对接（ERP/进销存等） */
  | "internal_system"
  /** 需要用户上传资料 */
  | "upload";

/** 岗位（场景卡片的分组维度） */
export interface ScenarioRole {
  id: string;
  /** 岗位显示名，如「老板/总经理」 */
  name: string;
  /** 展示排序，越小越靠前 */
  sort: number;
}

/** promptTemplate 中的槽位说明：模板里以 {{key}} 占位 */
export interface ScenarioSlot {
  key: string;
  /** 槽位含义，如「同行公司名单」 */
  label: string;
  /** 示例值：「试一试」时直接以示例值填充模板，用户可再编辑 */
  example: string;
}

/** 单条预置场景（API 下发的公开形态，不含 source/enabled 内部字段） */
export interface ScenarioItem {
  id: string;
  /** 场景标题，如「竞品动态晨报」 */
  title: string;
  /** 所属岗位 id，对应 ScenarioRole.id */
  role: string;
  /** 适用行业（V1 原样返回、前端暂不消费） */
  industries: string[];
  mode: ScenarioMode;
  /** 一句话卖点 */
  pitch: string;
  /** 三段式剧本（以「→」分隔：你做什么 → AI 做什么 → 你得到什么） */
  story: string;
  /** 起手 prompt 模板，含 {{key}} 槽位 */
  promptTemplate: string;
  slots: ScenarioSlot[];
  requires: ScenarioRequirement[];
  /** 是否推荐配置为定时任务 */
  recommendCron: boolean;
}

/** GET /api/scenarios 响应体 */
export interface ScenarioLibraryResponse {
  /** 已按 sort 升序排列的岗位列表 */
  roles: ScenarioRole[];
  /** 仅含 enabled 的场景（服务端已过滤并剥离内部字段） */
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

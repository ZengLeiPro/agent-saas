/**
 * 连接器 CLI → 业务语言的映射词典。
 *
 * 客户在演示里看到的是「钉钉 · 创建待办」，真实会话里同一个动作是
 * `Shell · dws todo create ...`——落差就在这里。这张词典把命令行还原成业务
 * 语言：系统 + 动作，命令本身退到第二行。
 *
 * ## 为什么是结构化词典而不是平面 k-v
 *
 * 一条连接器条目要同时回答四个问题，缺一个就会造出假事实：
 *   1. 这是哪个系统（`systemName`）
 *   2. 这个子命令是哪个业务模块（`modules`）
 *   3. 这个动词是不是**写操作**（`actionVerbs[].write`）——读文档、查列表不该
 *      被渲染成「AI 动了你家系统」，回执徽标只给写操作
 *   4. 哪些调用根本不是业务动作（`excludePatterns`）——生产 11.6% 的 dws 调用
 *      是 agent 在读 `--help`，把它渲染成「钉钉 · 待办」属语义造假
 *   5. 哪些域名的链接可以当作业务事实透出（`urlWhitelist`）——裸 URL 正则在
 *      生产样本里 34% 是噪声域名（github/debian/npmjs/example.com）
 *
 * 本模块是**内置默认种子**。运行时优先用平台管理里配置的词典（DB），
 * 没有配置时回落到这里——CLI 升级后运营改词典即可，不必发版。
 */

export interface ConnectorActionVerb {
  /** 中文动作名，用于拼业务标题：`创建` + `待办` = 创建待办 */
  name: string;
  /** 是否写操作。只有写操作才配得上「AI 动了外部系统」这句话与回执徽标。 */
  write: boolean;
}

export interface ConnectorDictionaryEntry {
  /** CLI 可执行名（比较时取 basename，允许 `/usr/local/bin/dws`） */
  binary: string;
  /** 客户读得懂的系统名 */
  systemName: string;
  enabled: boolean;
  /** 子命令 → 中文模块名。未登记的子命令原样使用，不硬凑中文。 */
  modules: Record<string, string>;
  /** 动词 → 动作名 + 是否写操作。未登记的动词按「未知动作」处理，不猜写读。 */
  actionVerbs: Record<string, ConnectorActionVerb>;
  /**
   * 排除规则：命中即**不产出业务动作标题**（整条连接器识别返回 null）。
   * 按整 token 匹配，不做子串匹配——`--help-me` 不该被 `-h` 命中。
   */
  excludePatterns: string[];
  /** 业务域名白名单。只有这些域名下的 URL 才会被当作业务事实透出。 */
  urlWhitelist: string[];
}

/** 通用动词表。绝大多数 CLI 的动词是同一套，逐条目重复只会漂移。 */
const COMMON_ACTION_VERBS: Record<string, ConnectorActionVerb> = {
  // —— 写操作：会在外部系统里留下痕迹 ——
  create: { name: '创建', write: true },
  add: { name: '添加', write: true },
  new: { name: '新建', write: true },
  update: { name: '更新', write: true },
  edit: { name: '修改', write: true },
  patch: { name: '修改', write: true },
  set: { name: '设置', write: true },
  delete: { name: '删除', write: true },
  remove: { name: '移除', write: true },
  send: { name: '发送', write: true },
  submit: { name: '提交', write: true },
  post: { name: '发布', write: true },
  upload: { name: '上传', write: true },
  finish: { name: '完成', write: true },
  complete: { name: '完成', write: true },
  approve: { name: '同意', write: true },
  reject: { name: '拒绝', write: true },
  assign: { name: '指派', write: true },
  invite: { name: '邀请', write: true },
  cancel: { name: '取消', write: true },
  write: { name: '写入', write: true },
  append: { name: '追加', write: true },
  // —— 读操作：中性描述，不给回执徽标 ——
  list: { name: '查询', write: false },
  get: { name: '查询', write: false },
  show: { name: '查看', write: false },
  view: { name: '查看', write: false },
  read: { name: '读取', write: false },
  search: { name: '检索', write: false },
  query: { name: '查询', write: false },
  find: { name: '查找', write: false },
  // 动作名要能直接与模块名拼成一句话（`查看` + `授权` = 查看授权），
  // 所以这里一律用单动词，不写「查看状态」这种自带宾语的短语
  status: { name: '查看', write: false },
  info: { name: '查看', write: false },
  detail: { name: '查看', write: false },
  download: { name: '下载', write: false },
  export: { name: '导出', write: false },
  // —— 2026-08-04 按生产真实调用补齐（60 天窗口的降级样本）——
  // CLI 持续加子命令、词典不会自己跟上：漏掉的动词不报错，只是把英文原词漏给
  // 客户看（「钉钉 · 群聊与消息 · list-all」）。补的依据是生产调用频次，
  // 不是把 CLI 全部子命令搬进来。
  'list-all': { name: '查询', write: false }, // dws chat message list-all（60 天 33 次）
  'get-self': { name: '查询', write: false }, // dws contact user get-self（18 次）
  login: { name: '登录', write: false }, // dws auth login（29 次）：建立会话不产生业务对象，不盖章
  logout: { name: '登出', write: false }, // 与 login 同族，一并登记避免下次又降级
};

/** 读文档 / 探测版本这类调用不是业务动作，命中即不产出业务标题 */
const COMMON_EXCLUDE_PATTERNS = ['--help', '-h', 'help', '--version', '-V', '--usage'];

const DINGTALK_URL_HOSTS = ['alidocs.dingtalk.com', 'docs.dingtalk.com', 'shanji.dingtalk.com'];
const FEISHU_URL_HOSTS = ['*.feishu.cn', '*.larksuite.com'];

const FEISHU_MODULES: Record<string, string> = {
  im: '群聊与消息',
  chat: '群聊与消息',
  docx: '云文档',
  doc: '云文档',
  drive: '云盘',
  calendar: '日历',
  contact: '通讯录',
  task: '任务',
  bitable: '多维表格',
  sheet: '电子表格',
  wiki: '知识库',
  approval: '审批',
  mail: '邮箱',
  auth: '授权',
};

export const BUILTIN_CONNECTOR_DICTIONARY: readonly ConnectorDictionaryEntry[] = [
  {
    binary: 'dws',
    systemName: '钉钉',
    enabled: true,
    modules: {
      calendar: '日历',
      contact: '通讯录',
      todo: '待办',
      im: '群聊与消息',
      chat: '群聊与消息',
      approval: '审批',
      attendance: '考勤',
      report: '日志',
      doc: '钉钉文档',
      drive: '云盘',
      sheet: '在线表格',
      axls: '在线表格',
      table: 'AI 表格',
      aitable: 'AI 表格',
      kb: '知识库',
      mail: '邮箱',
      minutes: 'AI 听记',
      auth: '授权',
      // 2026-08-04 补：生产高频但此前缺映射，标题里漏英文原词
      aisearch: 'AI 搜问', // 官方 --help 原文；60 天有调用
      profile: '账号配置', // dws profile list（60 天 20 次）。语义依据=生产实测返回账号/组织/凭证到期
    },
    actionVerbs: {
      ...COMMON_ACTION_VERBS,
      // 钉钉 chat 特有子命令：通用动词表里放不下（其他 CLI 没有同名命令）
      'conversation-info': { name: '查询', write: false },
      'list-by-sender': { name: '查询', write: false },
    },
    excludePatterns: [...COMMON_EXCLUDE_PATTERNS],
    urlWhitelist: [...DINGTALK_URL_HOSTS],
  },
  {
    binary: 'lark',
    systemName: '飞书',
    enabled: true,
    modules: { ...FEISHU_MODULES },
    actionVerbs: { ...COMMON_ACTION_VERBS },
    excludePatterns: [...COMMON_EXCLUDE_PATTERNS],
    urlWhitelist: [...FEISHU_URL_HOSTS],
  },
  {
    binary: 'feishu',
    systemName: '飞书',
    enabled: true,
    modules: { ...FEISHU_MODULES },
    actionVerbs: { ...COMMON_ACTION_VERBS },
    excludePatterns: [...COMMON_EXCLUDE_PATTERNS],
    urlWhitelist: [...FEISHU_URL_HOSTS],
  },
  {
    binary: 'gog',
    systemName: 'Google 工作区',
    enabled: true,
    modules: {
      gmail: 'Gmail',
      drive: '云端硬盘',
      calendar: '日历',
      contacts: '通讯录',
    },
    actionVerbs: { ...COMMON_ACTION_VERBS },
    excludePatterns: [...COMMON_EXCLUDE_PATTERNS],
    urlWhitelist: [],
  },
] as const;

/** 深拷贝一份内置词典。用于播种 DB 与测试隔离——调用方改了不得污染内置常量。 */
export function cloneBuiltinConnectorDictionary(): ConnectorDictionaryEntry[] {
  return BUILTIN_CONNECTOR_DICTIONARY.map((entry) => ({
    ...entry,
    modules: { ...entry.modules },
    actionVerbs: Object.fromEntries(
      Object.entries(entry.actionVerbs).map(([verb, value]) => [verb, { ...value }]),
    ),
    excludePatterns: [...entry.excludePatterns],
    urlWhitelist: [...entry.urlWhitelist],
  }));
}

/**
 * 域名是否命中白名单。支持 `*.feishu.cn` 形式的一级通配。
 * 精确匹配与后缀匹配都要求边界对齐——`evilfeishu.cn` 不得命中 `*.feishu.cn`。
 */
export function matchesUrlWhitelist(host: string, whitelist: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  return whitelist.some((pattern) => {
    const target = pattern.toLowerCase().trim();
    if (!target) return false;
    if (target.startsWith('*.')) {
      const suffix = target.slice(1); // ".feishu.cn"
      return normalized.endsWith(suffix) || normalized === target.slice(2);
    }
    return normalized === target;
  });
}

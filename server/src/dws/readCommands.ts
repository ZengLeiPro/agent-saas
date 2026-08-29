// TASK-256（三轮 review 返工）：DWS 只读/写命令显式登记表。
//
// 背景：分类器以「全路径破坏性/写动词扫描 + 末尾 token 读白名单」为主，会误判两类
// 官方文档证实为纯查询的命令：
// 1. 读动作位于路径中间或命名空间含 approve 等破坏性 token（如 attendance.approve.list）；
// 2. 末尾 token 不在读白名单（如 calendar.event.suggest、aitable.view.get.frozen-cols）。
//
// 本登记表每条路径都逐一对照 workspace 技能池 references/products/*.md 核实为纯查询
// （无服务端副作用），并附文档出处。登记条目优先于全路径破坏性/写扫描；登记表之外
// 的未知命令保持 fail-closed（dangerous + neverAutoApprove）。新增条目必须先核实文档。
export const DWS_READ_COMMAND_PATHS: ReadonlySet<string> = new Set([
  // attendance.md:105-146 查询审批单 / 查询审批模板与提交链接（命名空间 approve 为查询对象，非审批动作）
  'attendance.approve.list',
  'attendance.approve.templates',
  // attendance.md「查询用户假期数据（仅管理员）」
  'attendance.report.query-leave',
  // calendar.md「建议日程时间」纯计算查询
  'calendar.event.suggest',
  // chat.md「查看群内所有机器人」
  'chat.group.bots',
  // chat.md:1710「分页拉取入群验证记录」
  'chat.group.list-join-validations',
  // chat.md「查询消息发送状态」
  'chat.message.query-send-status',
  // chat.md「翻译文本内容」纯计算，无服务端副作用
  'chat.text.translate',
  // contact.md「获取当前用户信息」get-self 的别名
  'contact.user.me',
  'contact.user.self',
  // aitable/aitable-view-extras.md:55-56 等视图属性读取（get 后接属性名，末尾 token 非读动词）
  'aitable.view.get.frozen-cols',
  'aitable.view.get.lock',
  'aitable.view.get.row-height',
  'aitable.view.get.fill-color-rule',
  // aitable.md 查询单个分享链接信息
  'aitable.form.share.get',
  // drive.md「获取最近访问/编辑的文档列表」「查询文件当前的公开发布状态」
  'drive.recent',
  'drive.publish.get',
  // doc.md 查询文档评论列表
  'doc.comment.list',
  // mail.md 查询自动回复设置
  'mail.auto-reply.get',
  // minutes.md 批量查询听记详情 / 关键字列表 / 待办提取结果
  'minutes.get.batch',
  'minutes.get.keywords',
  'minutes.get.todos',
  // oa.md「查询待我审批的任务 ID」「获取任务可回退的节点信息」（revert-task 的前置查询）
  'oa.approval.tasks',
  'oa.approval.revert-activities',
  // todo.md 查询待办评论列表
  'todo.comment.list',
]);

// 文档证实为写操作、但按末尾 token 会误判为读的命令（显式否决读判定）。
// chat.md「mute-at-all（关闭@所有人通知）」：以 all 结尾命中 READ_VERBS，实为通知开关写操作。
export const DWS_WRITE_COMMAND_PATHS: ReadonlySet<string> = new Set([
  'chat.mute-at-all',
]);

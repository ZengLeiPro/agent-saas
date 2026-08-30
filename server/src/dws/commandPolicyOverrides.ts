// DWS CLI schema 的已审计只读例外表。正式命令默认由 generated/commandPolicy.ts 精确分档；
// 这里只保留已核实的上游 effect/收录异常、破坏性同名查询或旧版别名；未知命令保持 fail-closed。
// 新增条目必须先对照 workspace 技能池 references/products/*.md、CLI help 或 schema 契约核实。
export const DWS_READ_COMMAND_OVERRIDES: ReadonlySet<string> = new Set([
  // agoal.md 旧版三级路径；当前 schema 未完整收录技能文档中的只读命令。
  'agoal.report.list-statistics',
  'agoal.user.rules',
  // attendance.md 的审批记录/模板查询；approve 是资源命名空间，不是执行审批动作。
  'attendance.approve.list',
  'attendance.approve.templates',
  'attendance.get-approve-template',
  'attendance.list-approve',
  // chat.md 的旧版只读别名仍未进入 1.0.60 schema catalog。
  'chat.message.list-unread-conversations',
  // contact.md 获取当前用户信息；旧版 CLI 别名未进入 1.0.55/1.0.60 schema catalog。
  'contact.user.me',
  'contact.user.self',
  // drive.md 查询公开发布状态；1.0.55/1.0.60 schema 将纯查询误标为 write。
  'drive.publish.get',
  // mail.md 的只读查询；旧版路径未进入 schema catalog。
  'mail.auto-reply.get',
  'mail.mailbox.profile',
  'mail.message.verify',
  // oa.md 获取任务可回退节点；旧版路径未进入 schema catalog。
  'oa.approval.revert-activities',
]);

// 1.0.55 schema 漏收、但 CLI 与文档均确认会产生外部副作用的写命令。
export const DWS_WRITE_COMMAND_OVERRIDES: ReadonlySet<string> = new Set([
  'chat.mute-at-all',
  'mail.rule.adjust',
]);

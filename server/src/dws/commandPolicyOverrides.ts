// DWS CLI schema 的已审计只读例外表。正式命令默认由 generated/commandPolicy.ts 精确分档；
// 这里只保留已核实的上游 effect 标注异常或旧版 skill/CLI 别名；未知命令保持 fail-closed。
// 新增条目必须先对照 workspace 技能池 references/products/*.md 或 CLI 契约核实。
export const DWS_READ_COMMAND_OVERRIDES: ReadonlySet<string> = new Set([
  // agoal.md 旧版三级路径；1.0.60 schema 对应只读别名 agoal +report-statistics-list。
  'agoal.report.list-statistics',
  // contact.md 获取当前用户信息；旧版 CLI 别名未进入 1.0.55/1.0.60 schema catalog。
  'contact.user.me',
  'contact.user.self',
  // drive.md 查询公开发布状态；1.0.55/1.0.60 schema 将纯查询误标为 write。
  'drive.publish.get',
  // mail.md 查询自动回复设置；旧版三级路径未进入 schema catalog。
  'mail.auto-reply.get',
  // oa.md 获取任务可回退节点；旧版路径未进入 schema catalog。
  'oa.approval.revert-activities',
]);

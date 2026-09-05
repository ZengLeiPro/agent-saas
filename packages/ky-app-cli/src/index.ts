// @kaiyan/ky-app-cli —— ky-app 命令行。
// Phase A 只落骨架与 bin 入口；doctor / mock 壳 / register / onboard / rotate-credential
// 在 Phase C 实现。

/** CLI 用法文本，bin 与 Phase C 的各子命令共用。 */
export const USAGE = [
  'ky-app <命令> [选项]',
  '',
  '命令：',
  '  doctor              运行一致性测试与 mock 壳（Phase C）',
  '  register            上传仓库 manifest 登记系统版本（依赖 WP2a 平台端点）',
  '  onboard             开箱：建组织、赠积分、注册安装、导入成员（依赖 WP2a 平台端点）',
  '  rotate-credential   轮换服务凭据（依赖 WP2a 平台端点）',
  '',
  '当前为 Phase A 骨架，全部子命令尚未实现（见 WP1 Phase C）。',
].join('\n');

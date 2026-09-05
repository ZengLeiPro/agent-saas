// create-ky-app —— 开沿定制项目脚手架（Hono + Vue 模板）。
// Phase A 只落骨架与 bin 入口；模板生成在 Phase C 实现。

/** CLI 用法文本，bin 与 Phase C 的生成器共用。 */
export const USAGE = [
  'create-ky-app <目标目录> [选项]',
  '',
  '选项：',
  '  --system-id <id>        系统 id（小写字母开头，3~24 字符）',
  '  --name <名称>           系统显示名',
  '  --link <目录|workspace> @kaiyan/* 依赖来源：tarball 目录或 workspace 绝对路径',
  '',
  '当前为 Phase A 骨架，模板生成尚未实现（见 WP1 Phase C）。',
].join('\n');

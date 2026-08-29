// DwsBusiness 风险策略必须与 Dockerfile 中实际安装的 CLI 精确一致；
// commandPolicy.test.ts 会在 Dockerfile 或 skill 版本变化时强制同步此值与对应 catalog。
export const DWS_ACTIVE_CLI_VERSION = '1.0.55';

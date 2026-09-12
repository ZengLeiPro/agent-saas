# 智谱 Coding Plan 套餐额度

## 入口与配置

在 `platform-console/resource-center/models` 使用已有模型分组的 API Key 和 Base URL。HTTPS 官方中国站 `open.bigmodel.cn`（默认端口、无 URL 用户名/密码）的分组自动识别为智谱；无需重新输入已保存在 SecretVault 的 Key。

「套餐用量查询」也可显式选择「智谱 Coding Plan（个人版）」或「不查询」。自建代理地址不自动识别；只有该分组保存的是智谱原始 Key 时才能显式启用。模型代理专用 Key 不能用于智谱官方监控鉴权。「测试额度查询」使用填写中的 Key，留空时由服务端读取该分组已保存的 Key，不新增快照。

部署后打开 `platform-console/runtime/provider-quota`，点击「立即采集」即可创建智谱卡片。随后沿用现有 Worker 五分钟周期采集和数据库快照机制。页面本身不自动轮询；卡片支持单独刷新、拖动排序和手动套餐到期备注。

## 统计口径

卡片对应模型分组，但查询结果是**个人账号共享套餐额度**，不是该 Key 的独立消耗。同账号的多个 Key/分组可能显示相同额度，不能相加；本实现不根据额度相同就猜测账号身份并合并卡片。团队席位及 Key 级归因不在本次范围。

使用 `/api/monitor/usage/quota/limit` 返回的 `limits`，兼容 `TOKENS_LIMIT`、`CREDIT_LIMIT`、`TIME_LIMIT`。窗口周期按返回的 unit/number 区分；优先采用完整计数计算比例，否则使用上游百分比。旧模型限额显示为「配额单位」，不误标成真实 Token。未知周期如实标记，绝对额度、套餐等级和重置时间缺失时不推算。

异常或空响应不能冒充正常 0% 用量。采集失败时保留上次成功窗口，采集时间停在上次成功并变红；不单独显示错误框或「采集失败」标签。此模块仅监控，不参与模型路由、账号优先级、重试或业务计费。

## 安全边界

仅平台管理员可以测试和刷新。监控目标固定为 `https://open.bigmodel.cn/api/monitor/usage/quota/limit`，不会使用配置中的任意 Base URL 发出带 Key 的监控请求；禁止重定向，15 秒超时。鉴权为直接的 Authorization Key（无额外 Bearer 前缀）。不向浏览器回传已保存 Key，不在快照或错误中写入 Key、Vault 引用或上游原始错误正文。

## 回归验证

主要用例位于：

- `server/src/quota/zhipuCodingPlanQuota.test.ts`：配额结构、计数、重置时间、异常和 HTTP 安全。
- `server/src/quota/providerQuotaService.zhipu.test.ts`：分组发现、Vault 复用、独立刷新、快照与失败回退。
- `server/src/__tests__/zhipuQuotaAdmin.test.ts`：权限、请求校验和配置切换。
- `web/src/components/PlatformAdmin/pages/ZhipuQuotaIntegration.test.tsx`：表单和卡片集成。

复用原数据库结构，没有新增迁移。配置 Zod 模块的精确摘要审核见 `docs/release/PR641-zhipu-quota-config-review-20260911.md`；保留发布门禁，未放宽 bundle 预算或测试阈值。真实套餐返回字段仍以账号实际响应为准；自动化测试使用模拟响应，不等于已执行生产账号联调。

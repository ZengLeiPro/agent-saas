# 受控渠道与阿里巴巴组织登录

## 使用场景

在以下任一场景读取本参考：

- 目标组织是阿里巴巴；
- 登录返回 `CHANNEL_REQUIRED`、`channel_not_allowed`、`enterprise_not_authorized` 或“应用暂不受信任”；
- 用户提到渠道码、`DWS_CHANNEL`、渠道白名单或渠道归因；
- 需要判断 `DWS_CHANNEL` 与 `DINGTALK_DWS_AGENTCODE` 的边界。

## 核心契约

- 将 `DWS_CHANNEL` 作为产品/分发渠道 `channelCode`。CLI 在登录权限检查和后续 MCP 请求中把它发送为 `x-dws-channel`。
- 将 `DINGTALK_DWS_AGENTCODE` 作为执行 Agent 身份。两者是独立维度，禁止互相回填或复用。
- 仅使用与真实宿主/业务场景匹配的已登记渠道。禁止为了通过登录随机尝试其他渠道或伪装成别的产品。
- 把静态 `channelCode` 视为公开路由标识，不视为密钥或可信归因凭证。长期方案必须由服务端校验宿主身份并签发短期、绑定组织和渠道的会话凭证。

## SaaS 排查流程

SaaS 会话中的 Agent **不得执行 `dws auth login`**。`DWS_CHANNEL` 由连接器授权任务和宿主运行时按真实业务场景注入，Agent 不得自行设置、猜测或切换。

1. 引导用户打开连接器页的「钉钉」卡片，确认目标账号与组织。
2. 若卡片显示渠道或组织不受信任，报告 `CHANNEL_REQUIRED` 等原始错误，由平台 host 管理员核对已登记渠道与宿主配置。
3. host 修正配置后，让用户在连接器页点击「重新连接」；不要在会话中启动 device flow。
4. 连接成功后再执行一个最小只读产品命令验证。仍失败时保留原始服务端错误，禁止轮询尝试其他渠道。

## 仅平台外本地开发

只有脱离 SaaS 连接器、由开发者本人控制终端的本地调试，才可进行直接 CLI 登录：

1. 运行 `dws profile list --format json`，解析目标组织的稳定 `profile`。
2. 确认当前宿主配置的渠道与真实业务场景匹配。
3. 仅对单条命令设置 `DWS_CHANNEL`，执行 `dws auth login --profile <corpId:userId> --format json`；禁止写入 shell profile 或全局导出。
4. 使用相同 `DWS_CHANNEL` 和精确 `profile` 执行一个最小只读产品命令验证。
5. 若仍失败，加 `--verbose` 重试一次并按原始服务端错误分类；禁止轮询尝试其他渠道。

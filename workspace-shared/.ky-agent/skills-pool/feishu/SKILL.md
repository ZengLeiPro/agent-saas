---
name: feishu
description: 管理飞书文档、云盘、知识库、多维表格、电子表格、日历、会议、任务、审批、通讯录、群聊、消息、邮箱、妙记、OKR 等协同办公能力。当用户要求查询或操作飞书中的数据与工作事项时使用。
metadata:
  cli_package: "@larksuite/cli"
  cli_version: "1.0.73"
---

# 飞书全产品 Skill

通过官方 `lark-cli` 操作飞书。当前平台形态是「官方 CLI + 本 Skill」，不是 MCP Server。

## 平台运行时约定（优先级最高）

1. 用户必须先在「能力中心 → 连接器 → 飞书」完成一次官方授权。遇到未登录或授权失效，只引导用户回连接器页重新连接，**不要自行执行** `lark-cli auth login`、`config init`、`config bind` 或 `auth logout`。
2. 配置与加密凭据已按用户隔离到 `/workspace/.lark-cli/`：
   - `LARKSUITE_CLI_CONFIG_DIR=/workspace/.lark-cli/config`
   - `LARKSUITE_CLI_DATA_DIR=/workspace/.lark-cli/data`
   两个目录缺一不可；Agent 不得复制、读取、展示或修改其中的密钥/token 文件。
3. 平台连接器绑定的是当前用户身份。执行飞书业务命令时显式使用 `--as user`；只有用户明确要求以应用机器人身份操作时才考虑 `--as bot`。
4. App Secret、access token、refresh token、device code 永远不得输出到对话、文件或命令参数。不要用 `env`、`find`、`cat` 等方式探测凭据。
5. JSON 稳定模式已由容器环境关闭更新/技能通知。所有业务调用优先使用 JSON 输出，并以进程退出码及 JSON 的 `ok` 字段判断成功，禁止用旧式 `code == 0` 猜测。
6. `lark-cli` 自带与当前版本严格匹配的细分技能。选定产品后，**必须先执行** `lark-cli skills read <技能名>`，再按其中流程操作；不要读取或猜测 CLI 安装目录里的文件。

## 严格规则

- 禁止绕过 `lark-cli` 直接拼 OpenAPI、curl 或浏览器自动化操作飞书。
- 不编造 app ID、open_id、chat_id、document_id、folder_token、table_id 等标识符；必须从查询结果或用户提供的链接中提取。
- 不猜命令、flag、字段名。先加载对应的 CLI 内置技能，再按需运行 `lark-cli <service> --help`、`lark-cli <service> <resource> --help` 或 `lark-cli schema <path>`。
- 参考说明与当前二进制冲突时，以 `lark-cli --version` 和 `--help` 为准。
- 单次批量写入默认不超过 30 条；更大批次先向用户说明范围并分批执行。
- 写入前核对目标和关键字段；删除、覆盖、撤回、拒绝审批、移除成员、批量改权限等高影响动作必须先获得用户明确确认。

## 命令发现与输出契约

```bash
# 查看顶层服务与当前版本
lark-cli --help
lark-cli --version

# 查看某个服务/动作的真实参数
lark-cli docs --help
lark-cli calendar --help
lark-cli task --help

# 渐进加载与当前 CLI 版本匹配的细分技能（执行产品命令前必做）
lark-cli skills read lark-doc
lark-cli skills read lark-calendar

# 查询机器可读 schema；service/resource/method 以 help 返回为准，默认即 JSON
lark-cli schema <service.resource.method>

# 查看当前用户身份与登录态（只读）
lark-cli auth status --json --verify
lark-cli whoami
```

常见成功信封：

```json
{ "ok": true, "identity": "user", "data": {}, "meta": {} }
```

常见失败信封：

```json
{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "authorization",
    "subtype": "missing_scope",
    "message": "...",
    "hint": "...",
    "missing_scopes": []
  }
}
```

若缺少 scope：停止当前动作，把缺失权限和错误里的官方 `console_url`/修复提示告诉用户；不要自行重新发起登录，也不要切成 bot 身份蒙混过去。

## 产品路由

| 用户意图 | 首选服务 | 调用前加载 |
|---|---|---|
| 飞书文档创建、读取、编辑、评论 | `docs` | `lark-doc` |
| 云盘、文件、文件夹、上传下载 | `drive` | `lark-drive` |
| 知识库、空间、节点 | `wiki` | `lark-wiki` |
| 多维表格、数据表、字段、记录、视图 | `base` | `lark-base` |
| 电子表格、工作表、单元格、区域 | `sheets` | `lark-sheets` |
| 日历、日程、参与人、忙闲 | `calendar` | `lark-calendar` |
| 任务、清单、成员、评论 | `task` | `lark-task` |
| 审批实例、任务、同意/拒绝 | `approval` | `lark-approval` |
| 通讯录、员工、部门 | `contact` | `lark-contact` |
| 群聊、消息、成员、机器人消息 | `im` | `lark-im` |
| 邮件、邮箱、邮件组 | `mail` | `lark-mail` |
| 妙记、转写、会议纪要 | `minutes` | `lark-minutes` |
| 视频会议、会议室 | `vc` | `lark-vc` |
| 考勤 | `attendance` | `lark-attendance` |
| OKR | `okr` | `lark-okr` |
| 低代码应用与数据 | `apps` | 先读该服务 `--help`，再加载其明确要求的内置技能 |

以上是意图路由，不是命令契约。选中服务后仍要先读对应 `--help`，再构造调用。

## 身份纪律

- `user`：访问当前员工自己的日历、文档、云盘、邮箱、任务等；平台默认且首选。
- `bot`：以企业自建应用身份访问应用级资源，数据可见范围、对象归属和发送者都不同。
- Bot 看不到用户个人资源，也不能代表员工做个人操作。用户身份权限不足时，不得偷偷切 bot。
- 回答里若涉及“是谁执行”，以返回 JSON 的 `identity` 为事实源。

## 高风险写操作门禁

官方 CLI 对部分高风险操作会以退出码 `10` 返回：

```json
{
  "ok": false,
  "error": {
    "type": "confirmation",
    "subtype": "confirmation_required",
    "risk": "high-risk-write",
    "action": "...",
    "hint": "add --yes to confirm"
  }
}
```

处理流程：

1. 展示动作、目标、关键参数和影响范围。
2. 等待用户明确同意。
3. 仅在同意后，对原命令追加 `--yes` 重试一次。

绝不因退出码 10 自动追加 `--yes`，也不能用 shell 包装绕过门禁。需要先给用户预览时使用 CLI 支持的 `--dry-run`。

## 文件与错误处理

- CLI 文件参数优先使用当前工作区内的相对路径；不要把 NAS 绝对路径传给飞书 API。
- 遇到网络/限流错误，依据 JSON 的 retryable/hint 重试，避免重复写入；创建类动作重试前先查目标是否已经生成。
- 遇到权限、身份、目标不存在、参数校验错误时不要盲目重试。
- CLI 返回的 `console_url`、文档 URL、授权修复 URL 视为 opaque string，原样转交，不自行改写 query。

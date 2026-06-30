---
name: dws
description: 管理钉钉产品能力(AI表格/日历/通讯录/群聊与机器人/待办/审批/考勤/日志/DING消息/开放平台文档/钉钉文档/钉钉云盘/AI听记/邮箱/在线电子表格/知识库等)。当用户需要操作表格数据、管理日程会议、查询通讯录、管理群聊、机器人发消息、创建待办、提交审批、查看考勤、提交日报周报（钉钉日志模版）、读写钉钉文档、上传下载云盘文件、查询听记纪要、收发邮件、读写在线电子表格(axls)、管理钉钉知识库时使用。
cli_version: ">=1.0.15"
---

> ⚠️ **开沿专属约定（必读，先于本文档其他章节）**：执行任何 `dws` 命令前必须读 [references/kaiyan-context.md](./references/kaiyan-context.md)。下面 6 条是 2026-05-17 实战踩坑得到的硬规则，违反任何一条都会让授权流程或调用失败：
>
> 1. **Token 隔离三件套必注入**：`DWS_DISABLE_KEYCHAIN=1` + `DWS_CONFIG_DIR=$PWD/.dws/config` + `DWS_KEYCHAIN_DIR=$PWD/.dws/keys`。不注入会导致 token 落到 macOS Keychain，所有工作区共用同一份。建议执行 `source .dws/env.sh`（首次 setup 时由 `kaiyan-context.md §1` 创建）
> 2. **首次授权必须用 `nohup ... & disown` 启动 device flow**，不能用普通 `&` 或 `run_in_background`——普通后台进程会被 shell SIGHUP 杀掉，polling 在十几秒后死掉，用户扫码后 token 也回收不到。正确写法：`nohup bash -c 'source .dws/env.sh && dws auth login --device' > /tmp/dws-login.log 2>&1 < /dev/null & disown`
> 3. **绝对不要 `kill` / `pkill` dws 进程**：会让正在轮询的 polling 进程失效，用户已扫的 user_code 作废、必须发新 code 重扫。要确认进程状态用 `ps -ef \| grep "dws auth"`，要看 polling 心跳用 `tail -F /tmp/dws-login.log`
> 4. **device flow URL 让用户在自己设备扫**，不要试图让 agent 在 macmini 上完成授权——授权页面跑在钉钉服务器上，用户的手机或自己电脑浏览器都行，整个流程不需要任何人物理碰 macmini
> 5. **每个工作区独立授权**，绑定本工作区对应的钉钉账号；禁止复用 `dingtalk-docs` 的 `***REMOVED-PUBLIC-HISTORY-5***` 小号（那个只有发消息权限，dws 需要的 13+ 产品 scope 拿不到）
> 6. **职责边界**：TTS / 语音消息 / `[VOICE]` 标记走 `dingtalk-msg`；批量历史聚合（员工/部门/工时）走 `ky-data-query`；实时单点钉钉操作才走本 skill
>
> **Token 寿命（实际行为）**：access_token 2h 自动 refresh / refresh_token 30 天但**每次刷新 sliding window 自动延长 30 天**——只要月内调过一次 dws 命令就永不掉线。掉线唯一可能是连续 30 天工作区完全不用 dws。
>
> **撞到 `PAT_*_RISK_NO_PERMISSION` 错误是预期机制，不是 bug**——钉钉对涉及个人敏感数据（聊天记录/邮件/日程详情）的 API 要求用户单独按 scope 同意一次行为（叫「PAT 行为授权」）。处理方式：**把错误 JSON 里的 `authorizationUrl` 原样转给用户**，明确告知"在你自己的浏览器打开 → **选『永久』选项** → 同意 → 告诉我完成"，然后重试原命令。不要重试不要改命令——重试只会再得同样错误。完整机制见 [references/kaiyan-context.md](./references/kaiyan-context.md) §7「PAT 行为授权机制」（含 4 个风险等级 / vs OAuth 对比 / `PAT_SCOPE_AUTH_REQUIRED` 与 `AGENT_CODE_NOT_EXISTS` 两个特殊错误码）。
>
> **如果有任何调用失败**，先按这 6 条对照排查；仍不通时读完整 [references/kaiyan-context.md](./references/kaiyan-context.md) §6 故障特征表 + §7 PAT 章节。

## 🚀 首次授权 — 一段式可执行脚本（用户说"开通钉钉/接入 dws/初始化钉钉助理"时按顺序跑）

```bash
# 步骤 1：检查 dws 二进制
which dws || { echo "请联系曾磊在 macmini 上跑 npm install -g dingtalk-workspace-cli"; exit 1; }

# 步骤 2：如果工作区没有 .dws/env.sh，自动创建
[ -f .dws/env.sh ] || {
  mkdir -p .dws/config .dws/keys
  cat > .dws/env.sh <<'EOF'
export DWS_DISABLE_KEYCHAIN=1
export DWS_CONFIG_DIR="$PWD/.dws/config"
export DWS_KEYCHAIN_DIR="$PWD/.dws/keys"
EOF
}

# 步骤 3：检查是否已授权
source .dws/env.sh && dws auth status --format json | grep -q '"authenticated": true' && {
  echo "已登录，直接烟雾测试"
} || {
  # 步骤 4：以 nohup 启动 device flow（必须 nohup，否则 polling 被 SIGHUP 杀）
  rm -f /tmp/dws-login.log
  nohup bash -c 'source .dws/env.sh && dws auth login --device' > /tmp/dws-login.log 2>&1 < /dev/null & disown

  # 步骤 5：等 user_code 出现，提取给用户
  until grep -q "authorization code:" /tmp/dws-login.log 2>/dev/null; do sleep 1; done
  CODE=$(grep -oE "[A-Z0-9]{4}-[A-Z0-9]{4}" /tmp/dws-login.log | head -1)
  echo "请在你自己的手机或电脑浏览器打开（不是 macmini！）："
  echo "  https://login.dingtalk.com/oauth2/device/verify.htm?user_code=$CODE"
  echo "登录钉钉 → 选「福建开沿科技有限公司」 → 点「同意」"
  echo "授权码 15 分钟有效。完成后告诉我。"
}

# 步骤 6：用户扫码后烟雾测试
source .dws/env.sh && dws auth status --format json
source .dws/env.sh && dws contact user get-self --format json
```

**关键纪律**：
- 步骤 4 启动后**绝对不要 kill/pkill 任何 dws 相关进程**——会让用户扫的 code 失效
- 用 `Monitor` 工具盯 polling 进度：`tail -F /tmp/dws-login.log | grep --line-buffered -E "polling|success|error|expired"`
- 用户扫完码、`auth status` 显示 `authenticated: true` 后即完成，再跑 `dws contact user get-self` 让用户看到自己的钉钉档案作为确认

# 钉钉全产品 Skill

通过 `dws` 命令管理钉钉产品能力。

## 严格禁止 (NEVER DO)
- 不要使用 dws 命令以外的方式操作（禁止 curl、HTTP API、浏览器）
- 不要编造 UUID、ID 等标识符，必须从命令返回中提取
- 不要猜测字段名/参数值，操作前必须先查询确认

## 严格要求 (MUST DO)
- 所有命令必须加 `--format json` 以获取可解析输出
- 危险操作必须先向用户确认，用户同意后才加 `--yes` 执行
- 单次批量操作不超过 30 条记录
- 所有命令必须**严格遵循**对应产品参考文档里面规定的参数格式（如：如果有参数值，则参数和参数值之间至少用一个空格隔开）


## 产品总览

| 产品                | 用途                                                   | 参考文件                                                           |
|-------------------|------------------------------------------------------|----------------------------------------------------------------|
| `aitable`         | AI表格：Base/数据表/字段/记录/视图/附件/图表/仪表盘/导入导出/模板搜索            | [aitable.md](./references/products/aitable.md)                 |
| `attendance`      | 考勤：打卡记录/排班查询/考勤规则/汇总统计                             | [attendance.md](./references/products/attendance.md)           |
| `calendar`        | 日历：日程/参与者/会议室/闲忙查询/时间建议                             | [calendar.md](./references/products/calendar.md)               |
| `chat`            | 群聊与机器人：搜索群/建群/群成员管理/改群名/机器人群发/单聊/撤回/Webhook/机器人搜索     | [chat.md](./references/products/chat.md)                       |
| `contact`         | 通讯录：用户查询(当前用户/搜索/详情/手机号)/部门查询(搜索/成员列表)              | [contact.md](./references/products/contact.md)                 |
| `devdoc`          | 开放平台文档：搜索开发文档                                        | [devdoc.md](./references/products/devdoc.md)                   |
| `ding`            | DING消息：发送/撤回（应用内/短信/电话）                              | [ding.md](./references/products/ding.md)                       |
| `doc`             | 钉钉文档：搜索/浏览/读写/块级编辑/评论/文件创建/复制/移动/重命名                | [doc.md](./references/products/doc.md)                         |
| `drive`           | 钉钉云盘：文件列表/元数据/文件夹/上传(两步)/下载                        | [drive.md](./references/products/drive.md)                     |
| `minutes`         | AI听记：听记列表/摘要/关键词/转写/待办/思维导图/发言人/热词/上传                | [minutes.md](./references/products/minutes.md)                 |
| `oa`              | OA审批：待办/我发起的/表单模板/详情/审批流水/同意/拒绝/撤销                   | [oa.md](./references/products/oa.md)                           |
| `report`          | 日志：按模版创建/收件箱/已发送/模版查看/详情/已读统计                         | [report.md](./references/products/report.md)                   |
| `mail`            | 邮箱：邮箱地址查询/邮件搜索(KQL)/邮件详情/发送邮件                        | [mail.md](./references/products/mail.md)                       |
| `sheet`           | 在线电子表格(axls)：工作表 CRUD/区域读写/行列增删/合并/查找替换/筛选视图/导出(两步)/图片 | [sheet.md](./references/products/sheet.md)                     |
| `todo`            | 待办：创建(含优先级/截止时间/循环)/查询/修改/标记完成/删除                   | [todo.md](./references/products/todo.md)                       |
| `wiki`            | 知识库：空间创建/详情/列表/搜索 + 成员管理                                | [wiki.md](./references/products/wiki.md)                       |

## 意图判断决策树

用户提到"表格/多维表/AI表格/记录/数据/视图/图表/仪表盘" → `aitable`
用户提到"考勤/打卡/排班" → `attendance`
用户提到"日程/日历/会议室/约会/时间建议" → `calendar`
用户提到"群聊/建群/群成员/群管理/机器人发消息/Webhook/机器人群发/机器人单聊/通知" → `chat`
用户提到"通讯录/同事/部门/组织架构" → `contact`
用户提到"开发/API/调用错误 文档" → `devdoc`
用户提到"DING/紧急消息/电话提醒" → `ding`
用户提到"钉钉文档/云文档/知识库/读写文档/块级编辑/文档评论/文档复制移动" → `doc`
用户提到"云盘/文件存储/文件上传下载/文件夹" → `drive`
用户提到"听记/AI听记/会议纪要/转写/摘要/思维导图/发言人/热词" → `minutes`
用户提到"邮箱/邮件/发邮件/收邮件/搜邮件/查邮件" → `mail`
用户提到"审批/请假/报销/出差/加班/同意/拒绝/撤销审批" → `oa`
用户提到"日志/日报/周报/日志统计/写日报/提交周报/发日志/填日志" → `report`
用户提到"在线电子表格/钉钉表格/axls/工作表/单元格读写/合并单元格/筛选视图/导出 xlsx" → `sheet`
用户提到"待办/TODO/任务提醒/循环待办" → `todo`
用户提到"知识库/wiki/团队空间/知识库成员管理" → `wiki`

关键区分: aitable(数据表格) vs todo(待办任务)
关键区分: report(钉钉日志/日报周报) vs todo(待办任务)
关键区分: chat send-by-bot(机器人身份发消息) vs send-by-webhook(自定义机器人Webhook告警)
关键区分: doc(钉钉文档/富文本协同) vs drive(钉钉云盘/二进制文件)
关键区分: oa tasks(审批 taskId，审批/拒绝用) vs oa list-pending(收件箱 processInstanceId，查看用)


> 更多易混淆场景见 [intent-guide.md](./references/intent-guide.md)

## 危险操作确认

以下操作为不可逆或高影响操作，执行前**必须先向用户展示操作摘要并获得明确同意**，同意后才加 `--yes` 执行。

| 产品 | 命令 | 说明 |
|------|------|------|
| `aitable` | `base delete` | 删除整个 AI 表格，含全部数据表和记录 |
| `aitable` | `table delete` | 删除数据表（含全部字段/视图/记录） |
| `aitable` | `field delete` | 删除字段（该列所有值同步清空） |
| `aitable` | `view delete` | 删除视图 |
| `aitable` | `record delete` | 删除记录（支持批量） |
| `aitable` | `chart delete` / `dashboard delete` | 删除图表/仪表盘 |
| `calendar` | `event delete` | 删除日程，所有参与者同步取消 |
| `calendar` | `participant delete` | 移除日程参与者 |
| `calendar` | `room delete` | 取消会议室预定 |
| `chat` | `group members remove` | 移除群成员 |
| `chat` | `message recall-by-bot` | 撤回机器人已发消息 |
| `doc` | `block delete` | 删除文档块（不可恢复） |
| `ding` | `message recall` | 撤回已发 DING 消息 |
| `oa` | `approval revoke` | 撤销自己发起的审批实例 |
| `oa` | `approval reject` | 拒绝待审批（需加明确理由） |
| `todo` | `task delete` | 删除待办 |
| `minutes` | `replace-text` | 全文批量替换转写与摘要 |

### 确认流程
```
Step 1 → 展示操作摘要（操作类型 + 目标对象 + 影响范围）
Step 2 → 用户明确回复确认（如 "确认" / "好的"）
Step 3 → 加 --yes 执行命令
```

## 核心流程
作为一个智能助手，你的首要任务是**理解用户的真实、完整的意图**，而不是简单地执行命令。在选择 `dws` 的产品命令前，必须严格遵循以下四步流程：

0. **URL 预检**：输入含 `alidocs.dingtalk.com` URL 时，该域名下存在多种路径格式（`/i/nodes/...`、`/i/p/...`、`/spreadsheetv2/...`、`/document/edit|preview?dentryKey=...` 等），每种的处理流程不同。**必须先读取 [url-patterns.md](./references/url-patterns.md) 中的「alidocs URL 分流决策」**，按其中规则识别 URL 类型后再选择对应产品。含 `shanji.dingtalk.com` URL 时直接路由到 `minutes`。URL 已识别后直接进入对应产品流程，无需后续步骤。
1. 意图分类：首先，判断用户指令的核心 动词/动作 属于哪一类。这比关注名词更重要。
2. 歧义处理与信息追问：如果用户指令模糊或包含多个产品的关键字，严禁猜测。必须主动向用户追问以澄清意图。这是你作为智能助手而非命令执行器的核心价值。
3. 精准产品映射：在完成前两步，意图已经清晰后，参考产品总览和意图判断决策树 来选择产品。
4. 充分阅读产品参考文件，通过编写代码或直接调用指令实现用户意图。

## 命令发现（flag / 参数以 binary 为准）

产品参考文档（`references/products/*.md`）里的 flag 列表是**便于理解用途的参考**，不是权威契约。参数名称、默认值、必填约束随服务发现动态变化，**以下两个命令的输出才是调用的事实源**：

```bash
# 1) 人读视图：看 Usage / Example / Flags
dws <command-path> --help
# 例：dws calendar event list --help

# 2) 机读视图：JSON Schema + flag 别名映射 + 必填字段
dws schema                                 # 列出所有产品及工具
dws schema <product>.<canonical_name>      # 规范路径（如 calendar.list_suggested_event_times）
dws schema "<product> <group> <cli_name>"  # CLI 路径（如 "calendar event list"）
dws schema <path> --jq '.tool.flag_overlay'  # 只看 flag 别名
dws schema <path> --jq '.tool.required'      # 只看必填字段
```

**何时用哪条路径：**
- 只需看某个命令怎么调用 → `dws <cmd> --help`
- 构造 `--params` / `--json` 时不确定字段类型、必填、别名 → `dws schema <path>`
- 参考文档和 `--help` 冲突时 → **以 `--help` / `dws schema` 为准**，文档视为过期

`dws schema` 输出的 `flag_overlay[key].alias` 就是实际生效的 flag 名（如 `attendeeUserIds → --attendee-user-ids`）；`parameters[key]` 是原始 JSON Schema；`required` 是必填字段数组；`sensitive: true` 表示写/删操作，须先向用户确认再加 `--yes`。

## 错误处理
1. 遇到错误，加 `--verbose` 重试一次
2. 若 stderr 出现 `RECOVERY_EVENT_ID=<event_id>`，优先按 [recovery-guide.md](./references/recovery-guide.md) 执行 recovery 闭环
3. 仍然失败，报告完整错误信息给用户，禁止自行尝试替代方案
4. 认证失败时，参考 [global-reference.md](./references/global-reference.md) 中的认证章节处理
5. 各产品高频错误及排查流程见 [error-codes.md](./references/error-codes.md)


## 详细参考 (按需读取)

- [references/products/](./references/products/) — 各产品命令详细参考（flag 细节以 `--help` / `dws schema` 为准）
- [references/intent-guide.md](./references/intent-guide.md) — 意图路由指南（易混淆场景对照）
- [references/url-patterns.md](./references/url-patterns.md) — URL 格式规范 + alidocs URL 分流决策与类型探测流程（含钉盘 `document/edit|preview?dentryKey=` 链接）
- [references/global-reference.md](./references/global-reference.md) — 全局标志、认证、输出格式
- [references/field-rules.md](./references/field-rules.md) — AI表格字段类型规则
- [references/error-codes.md](./references/error-codes.md) — 错误码 + 调试流程
- [references/recovery-guide.md](./references/recovery-guide.md) — recovery 闭环、`RECOVERY_EVENT_ID`、`execute/finalize` 规范
- [scripts/](./scripts/) — 各产品批量操作脚本（AI表格/日历/机器人消息/通讯录/考勤/日志/待办等）

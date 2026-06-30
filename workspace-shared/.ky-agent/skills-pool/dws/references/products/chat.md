# 会话与群聊 (chat) 命令参考

> 命令别名: `dws im` 等价于 `dws chat`

## 命令总览

### group (群组管理)

| 子命令 | 用途 |
|-------|------|
| `group create` | 创建内部群 |
| `group members` | 查看群成员列表 |
| `group members add` | 添加群成员 |
| `group members remove` | 移除群成员（⚠️ 危险操作） |
| `group members add-bot` | 添加机器人到群 |
| `group rename` | 修改群名称 |
| `search` | 搜索群会话 |
| `search-common` | 搜索共同群 |
| `conversation-info` | 获取会话基础信息（单聊/群聊） |

### message (会话消息管理)

| 子命令 | 用途 |
|-------|------|
| `message send` | 以当前用户身份发群消息或单聊消息 |
| `message list` | 拉取群聊或单聊会话消息 |
| `message list-all` | 按时间范围拉取当前用户所有会话消息 |
| `message list-topic-replies` | 拉取群话题回复消息列表 |
| `message list-by-sender` | 搜索指定发送者的消息 |
| `message list-mentions` | 拉取 @我 的消息 |
| `message list-focused` | 拉取特别关注人的消息 |
| `message list-unread-conversations` | 获取未读会话列表 |
| `message search` | 按关键词搜索消息 |
| `message send-by-bot` | 机器人发消息（群聊或批量单聊） |
| `message recall-by-bot` | 机器人撤回消息 |
| `message send-by-webhook` | 自定义机器人 Webhook 发消息 |
| `list-top-conversations` | 拉取置顶会话列表 |

### bot (机器人管理)

| 子命令 | 用途 |
|-------|------|
| `bot search` | 搜索我的机器人 |

---

## ⚠️ 重要陷阱合集（必读，2026-05-17 起持续实测沉淀，末次更新 2026-05-21）

### 1. Markdown / 多行内容传值规范

`message send` / `send-by-bot` / `send-by-webhook` 的 `--text` 都**支持 Markdown**，但 bash **不会自动转义** `"..."` 双引号字符串里的 `\n` —— 直接写 `--text "## 标题\n\n正文"` 会把字面两字符 `\n` 传给钉钉，导致整段塌成一行、`##`/`**`/反引号等 Markdown 标记**全部失效**（因为不在行首）。

**正确写法（三选一）：**

```bash
# 方式 1: 用 $'...' 让 bash 解析转义（推荐 — 单行命令最简洁）
dws chat message send-by-bot --robot-code <code> --users <userId> \
  --title "周报" --text $'## 本周进展\n\n- 完成 A\n- 推进 B\n\n> 下周聚焦 C'

# 方式 2: 用 printf 子命令（推荐 — 内容长时更清晰）
dws chat message send-by-bot --robot-code <code> --users <userId> \
  --title "周报" --text "$(printf '## 本周进展\n\n- 完成 A\n- 推进 B\n')"

# 方式 3: heredoc + cat（推荐 — 内容超长 / 多段时最易读）
TEXT=$(cat <<'EOF'
## 本周进展

- 完成 A
- 推进 B

> 下周聚焦 C
EOF
)
dws chat message send-by-bot --robot-code <code> --users <userId> --title "周报" --text "$TEXT"
```

**错误写法（必踩坑）：**

```bash
# ❌ 双引号里的 \n 是字面字符，不是换行符
--text "## 标题\n\n正文"
# 钉钉端实际收到："## 标题\n\n正文" → 渲染为一坨纯文本，## 也不生效
```

**自检方法**：发送前先 `printf '...'` 看输出是否真换行；或发完后到钉钉看是否多段。如果整条消息塌成一行且 Markdown 标记都是字面字符 → 100% 是 bash 转义问题，立即按上面三种方式重发。

> 💡 该规则同样适用于钉钉文档、AI 表格 richText、邮件正文等所有支持 Markdown / 多行的 `--text` / `--content` 类参数。

### 2. 所有写操作均需按 scope 独立二次授权（PAT_MEDIUM_RISK）

钉钉把写操作切成细粒度 scope，**每个 scope 在首次调用时都会触发独立的浏览器授权弹窗**（即使之前已经登录过、即使其他写操作已授权过）。报错形如 `PAT_MEDIUM_RISK_NO_PERMISSION`，stderr 会返回 `authorizationUrl` 和 6 位 userCode（如 `RT4F-3LXY`），需用户在浏览器同意（可选 `once` 一次性或 `permanent` 30 天有效）后才能重试。

| 操作 | scope |
|------|-------|
| 个人代发消息 | `chat.message:send` |
| 机器人发群/单聊 | `chat.message:send-by-bot` |
| 机器人撤回消息 | `chat.message:recall-by-bot` |
| 把机器人加入群 | `chat.group.members:add-bot` |
| 移除群成员 | `chat.group.members:remove` |

**Agent 行为规范**：遇到 `PAT_MEDIUM_RISK_NO_PERMISSION` **不要重试**——把 stderr 里的 `authorizationUrl` 完整呈现给用户，等用户手动授权完成回复"好了"后再重试同一条命令。同 scope 选择 `permanent` 后 30 天内同类命令直接通过。

### 3. `send-by-bot --group` 前置：机器人必须先在该群里

应用机器人给群发消息**必须先入群**——否则 API 返回误导性错误 `robot 不存在；解决方案:请确认 robotCode 是否正确`（实际 robotCode 完全正确，问题是机器人不在群成员里）。

**正确顺序**：先 `group members add-bot` → 再 `message send-by-bot --group`。给本人或群成员发**单聊**（`send-by-bot --users`）则无此限制。

### 4. `send-by-bot` 不支持 @所有人 / @个人（钉钉 API 设计如此）

`dws schema` 显示 `bot.send_robot_group_message` 真实参数**只有 4 个**：`markdown / openConversationId / robotCode / title`——**没有任何 @ 相关字段**。这是钉钉应用机器人 API 的硬限制，不是 CLI 缺漏：

| 发送方式 | 能 @所有人 | 能 @个人 |
|---------|----------|---------|
| `message send`（个人代发） | ✅ `--at-all` | ✅ `--at-users` |
| `message send-by-bot`（应用机器人）| ❌ | ❌ |
| `message send-by-webhook`（Webhook 机器人）| ✅ `--at-all` | ✅ `--at-users` / `--at-mobiles` |

在 `send-by-bot` 的 text 里写 `<@all>` 或 `<@userId>` 占位符**字面字符会原样显示**，不会被解析为强提醒。需要 @ 能力时只有两条路：① 用 webhook 机器人 ② 用个人代发（发件人是当前登录用户而非机器人）。

### 5. `message list --user` / `--open-dingtalk-id` 拉单聊**静默返回空**（CLI 路由 bug，2026-05-19 实测）

`dws chat message list --user <userId>` 和 `--open-dingtalk-id <openDingTalkId>` 在 PAT 环境下**返回 0 条且不报任何错误**，极易让人误判为"两人没聊过"。这是 dws CLI v1.0.28 的路由 bug，与 GH issue #185 同根因（已上报新 issue 跟进根本修复）。

**根因**：`chat` 产品下云端实际有两个独立 RPC 工具：
- `list_conversation_message_v2` — 只接受 `openconversation_id`（必填）
- `list_individual_chat_message` — 接受 `userId` 或 `openDingTalkId`，专门拉单聊双向消息

但 dws CLI 的 `chat message list` 命令**只绑定到了 v2**，其 `flag_overlay` 又把 `--user`/`--open-dingtalk-id` 注册成了别名，结果传 `--user` 时参数被路由到不接受 userId 的 v2，缺必填的 openconversation_id 又静默返回空。

**正确做法（按推荐度排序）：**

```bash
# 方式 1（推荐）：直接调底层单聊 RPC，单步搞定双向消息
dws mcp chat list_individual_chat_message \
  --json '{"userId":"<userId>","time":"2026-05-19 00:00:00","forward":true,"limit":100}' \
  --format json

# 方式 2（CLI 友好）：两步——先用 list-by-sender 拿单聊 openConversationId，再用 --group
# Step 1: 从 list-by-sender 返回的消息里找 conversationType=1 那条，取 openConversationId
dws chat message list-by-sender --sender-user-id <对方userId> \
  --start "2026-05-19 00:00:00" --end "2026-05-19 23:59:59" --limit 5 --format json
# Step 2: 用拿到的 openConversationId 拉完整双向消息
dws chat message list --group <单聊openConversationId> \
  --time "2026-05-19 00:00:00" --forward=true --limit 100 --format json
```

**禁忌**：不要再用 `dws chat message list --user <userId>` 或 `--open-dingtalk-id <openDingTalkId>` 拉单聊——它不会报错但也拿不到数据。本文档其他地方提到这两个 flag 拉单聊的描述均为遗留错误，以本节为准。

### 6. `send-by-bot` 撞 `endpoint not resolved for product "bot"` → 走 mcp 直调（CLI alias bug，2026-05-21 实测）

`dws chat message send-by-bot` 报错：

```
endpoint not resolved for product "bot" (tool "batch_send_robot_msg_to_users"):
product missing from discovery catalog and no supplement/env override
```

**根因**：dws CLI 内部把这个命令的 `server_key` 错误地映射成 `"bot"`，但 discovery catalog 里这个工具的真实 product id 是 **`group`**（`dws schema` 输出明确显示 `group.batch_send_robot_msg_to_users`），22 个 product 列表里**根本没有 `bot`**。这是 CLI alias 配置 bug，与 envelope 下发、缓存、授权全部无关。

> ⚠️ **错误信息里 `Run: dws cache refresh` 的建议是误导性 hint，不要听**——刷新 cache 永远救不了写死的 alias 映射，重复 refresh 只是浪费时间。已在 admin 与 huangyp 两个工作区独立复现，确认非环境问题。

**正确做法**：绕过 CLI alias 层，直接走 mcp 调规范路径

```bash
dws mcp group batch_send_robot_msg_to_users --json '{
  "robotCode": "<robotCode>",
  "userIds": ["<userId1>", "<userId2>"],
  "title": "<消息标题>",
  "markdown": "<Markdown 正文>"
}' --format json
```

必填字段 4 个（`dws schema group.batch_send_robot_msg_to_users` 可查）：`robotCode` / `userIds`（数组）/ `title` / `markdown`。

**同类受影响命令**（CLI 别名层一旦撞同款错就用同样手法降级）：
- `chat message send-by-bot --group ...` → `dws mcp group send_robot_group_message --json '{...}'`
- `chat message recall-by-bot` → `dws mcp group batch_recall_robot_users_msg --json '{"processQueryKeys":[...],"robotCode":"..."}'`

**自检方法**：任意 CLI 命令报 `endpoint not resolved for product "<X>"` 时，立即跑 `dws schema | grep -B1 <tool_name>` 看真实 product 是什么，然后用 `dws mcp <真实product> <tool_name> --json '...'` 直调。**不要先 cache refresh、不要重试原命令**。

### 7. `message list` 长时间窗口翻页时 `hasMore` 字段会**假性提前 false**导致漏拉（2026-05-24 实测）

按 `--time + --forward=true` 翻拉某个群 5 月一整月的消息时，**很多群在 5 月早期就被 `hasMore=false` 中断**（如 KY Core 停在 5/1，招聘助理停在 5/4，全员群停在 5/18），但实际 5/24 之前这些群继续有消息——用 `--time "2026-05-20 00:00:00"` 单独查能拉到。这是 `chat message list` 在跨较长时间窗口、消息密度不均时的固有问题，不是 PAT/缓存/路由问题。

**正确翻页策略**：**忽略 `hasMore` 字段，按时间是否推进到目标终点判断是否停**。

```python
# 主循环：用 last_msg.createTime + 1s 推进
cursor = start_time
while True:
    data = dws_list(group_oid, cursor)
    msgs = data["result"]["messages"]
    if not msgs:
        # 跳 30 分钟探测，连续 3 次空才真停
        cursor = (datetime.parse(cursor) + timedelta(minutes=30)).strftime(...)
        if cursor > end_time: break
        continue
    write_all(msgs)
    last_time = msgs[-1]["createTime"]
    if last_time >= end_time: break
    cursor = (datetime.parse(last_time) + timedelta(seconds=1)).strftime(...)
```

**不要做**：`if not has_more: break` —— 会让 64% 的群提前中断。

**补漏方案**：第一遍 fetch 完成后跑一个 fill-gaps 第二遍——读每个群 jsonl 末尾 createTime，从那里 -5 秒（防边界丢失）继续翻；每个空批次跳 30 分钟探测；连续 3 次空才真停。在 16 个群 2800 条消息的实测中，第二遍补回 654 条（招聘助理告警群 +270 条、线上营销 +307 条、全员群 +77 条）。

### 8. `dws ... --format json` 输出含未转义控制字符，jq 解析失败（2026-05-24 实测）

钉钉消息正文里的 `\n`、`\t` 等会原样落入 JSON 字符串字段，导致 `jq` 报 `Invalid string: control characters from U+0000 through U+001F must be escaped`，整个解析失败。

**解决方案**：改用 Python `json.loads(s, strict=False)` 来解析 dws 输出。bash 链路里的 `jq` 也要换成 `python3 -c "import sys, json; d = json.loads(sys.stdin.read(), strict=False); ..."`。

```bash
# ❌ 错（很多群消息会失败）
dws chat message list --group <oid> --format json | jq '.result.messages'

# ✅ 对
dws chat message list --group <oid> --format json | \
  python3 -c "import sys, json; d = json.loads(sys.stdin.read(), strict=False); print(len(d['result']['messages']))"
```

**消息字段名也要校准**：去重用 `openMessageId`（不是 `msgId` / `messageId`）；时间字段是 `createTime`（格式 `yyyy-MM-dd HH:mm:ss`）；发送人是 `sender` + `senderOpenDingTalkId`。

---

## group create — 创建内部群

当前登录用户自动成为群主。

```
Usage:
  dws chat group create [flags]
Example:
  dws chat group create --name "Q1 项目冲刺群" --users userId1,userId2,userId3
Flags:
      --users string    成员 userId 列表，用户本身会自动加入，无需包含，逗号分隔，不超过20个 (必填)
      --name string     群名称 (必填)
```

---

## group members list — 查看群成员列表

分页查询指定群聊的成员。

```
Usage:
  dws chat group members list [flags]
Example:
  dws chat group members list --id <openconversation_id>
Flags:
      --cursor string   分页游标，首次从 0 开始
      --id string       群 ID / openconversation_id (必填)
```

> ⚠️ 注意：v1.0.17 起 list 是显式子命令；旧用法 `dws chat group members --id ...` 已不再支持，请改用 `dws chat group members list --id ...`。

---

## group members add — 添加群成员

向指定群聊添加成员，需传入群 ID 与用户 ID 列表。

```
Usage:
  dws chat group members add [flags]
Example:
  dws chat group members add --id <openconversation_id> --users userId1,userId2
Flags:
      --id string      群 ID / openconversation_id (必填)
      --users string   要添加的用户 userId 列表，逗号分隔 (必填)
```

---

## group members remove — 移除群成员

> ⚠️ 危险操作：执行前必须向用户确认，同意后才加 `--yes`。

```
Usage:
  dws chat group members remove [flags]
Example:
  dws chat group members remove --id <openconversation_id> --users userId1,userId2
Flags:
      --id string      群 ID / openconversation_id (必填)
      --users string   要移除的用户 userId 列表，逗号分隔 (必填)
```

---

## group members add-bot — 添加机器人到群

将自定义机器人添加到当前用户有管理权限的群聊中，如果没有权限则会报错。

```
Usage:
  dws chat group members add-bot [flags]
Example:
  dws chat group members add-bot --robot-code <robot-code> --id <openconversation_id>
Flags:
      --id string           群聊 openConversationId (必填)
      --robot-code string   机器人 Code (必填)
```

---

## group rename — 修改群名称

```
Usage:
  dws chat group rename [flags]
Example:
  dws chat group rename --id <openconversation_id> --name "新群名"
Flags:
      --id string     群 ID / openconversation_id (必填)
      --name string   修改后的群名称 (必填)
```

---

## search — 搜索群会话

根据名称搜索会话列表。

```
Usage:
  dws chat search [flags]
Example:
  dws chat search --query "项目冲刺"
Flags:
      --cursor string   分页游标 (首页留空)
      --query string    搜索关键词 (必填)
```

---

## search-common — 搜索共同群

根据昵称列表搜索共同群聊。--nicks 指定要搜索的人员昵称（逗号分隔，必填）。--match-mode 控制匹配模式：AND 表示所有人都在群里，OR 表示任一人在群里（默认 AND）。

```
Usage:
  dws chat search-common [flags]
Example:
  dws chat search-common --nicks "风雷,山乔" --limit 20 --cursor 0
  dws chat search-common --nicks "天鸡,乐函" --match-mode OR --limit 20 --cursor 0
  dws chat search-common --nicks "风雷,山乔,天鸡" --limit 10 --cursor <nextCursor>
Flags:
      --nicks string        要搜索的昵称列表，逗号分隔 (必填)
      --match-mode string   匹配模式：AND=所有人都在群里，OR=任一人在群里（默认 AND）
      --limit int           每页返回数量（默认 20）
      --cursor string       分页游标（默认 "0"，翻页传 nextCursor）

注意:
  - --nicks 传人员昵称（花名），逗号分隔，如 "风雷,山乔"
  - --match-mode AND 表示群里必须包含所有指定的人；OR 表示包含任意一人即可
  - 翻页：hasMore=true 时，用返回的 nextCursor 作为下次 --cursor
```

---

## message send — 以当前用户身份发消息

--group 指定群聊 ID 发群消息；--user 指定用户 userId 发单聊；--open-dingtalk-id 指定用户 openDingTalkId 发单聊。三者只能选其一，不能同时指定。消息内容为位置参数（恰好 1 个），支持 Markdown。`--title` 是消息标题，**群聊与单聊都必填**（API 强制要求；缺失时服务端返回误导性的 "发群服务窗会话消息失败"，CLI 现在前置校验直接报错）。
--群聊时可选 --at-all @所有人，或 --at-users 指定成员（仅群聊时生效）。
--发送图片消息：指定 --media-id（通过 dt_media_upload 工具上传获得），自动设置 msgType=image，此时不需要传文本内容。

```
Usage:
  dws chat message send [flags] [<text>]
Example:
  dws chat message send --group <openconversation_id> --title "周报" --text "请提交本周日报"
  dws chat message send --user <userId> --title "提醒" --text "请查收"
  dws chat message send --open-dingtalk-id <openDingTalkId> --title "提醒" --text "请查收"
  dws chat message send --group <openconversation_id> --title "通知" "hello"
  dws chat message send --group <openconversation_id> --title "周报提醒" --text "请大家本周五前提交周报"
  dws chat message send --group <openconversation_id> --title "通知" --at-all "<@all> 请大家注意"
  dws chat message send --group <openconversation_id> --title "通知" --at-users userId1,userId2 "<@userId1> <@userId2> 请查收"
  dws chat message send --group <openconversation_id> --title "图片" --media-id <mediaId>
  dws chat message send --open-dingtalk-id <openDingTalkId> --title "图片" --media-id <mediaId>
Flags:
      --text string              消息内容（推荐使用，也可用位置参数）
      --group string             群聊 openconversation_id（群聊时必填）
      --user string              接收人 userId（单聊时与 --open-dingtalk-id 二选一）
      --open-dingtalk-id string  接收人 openDingTalkId（单聊时与 --user 二选一，适用于三方应用等无法获取 userId 的场景）
      --title string             消息标题（必填）
      --at-all                   @所有人（仅群聊时生效，可选，默认 false）
      --at-users string          @指定成员的 userId 列表，逗号分隔（仅群聊时生效，可选）
      --at-mobiles string        @指定成员的手机号列表，逗号分隔（仅群聊时生效，可选）
      --media-id string          图片 mediaId（通过 dt_media_upload 工具上传获得，需从返回链接中去除 _宽_高.格式 后缀并加上 @ 前缀），指定后发送图片消息，不需要传文本内容
      --msg-type string          消息类型（可选，如 text/markdown/image/file；通常由 --text/--media-id/--dentry-id 自动推断）
      --dentry-id string         钉盘文件 dentryId（发送钉盘文件消息时使用，需配合 --space-id）
      --space-id string          钉盘空间 spaceId（与 --dentry-id 配合使用）
      --file-name string         文件消息的文件名
      --file-size string         文件消息的文件大小（字节）
      --file-type string         文件消息的文件类型（如 pdf / docx / xlsx 等）

注意:
  - --text 和位置参数二选一，--text 优先
  - --title 必填（群聊与单聊都必填，API 强制要求）
  - --group、--user、--open-dingtalk-id 三者互斥，只需指定其一：群聊用 --group，单聊用 --user 或 --open-dingtalk-id
  - --group 的别名: --id, --chat, --conversation-id (均可替代 --group)
  - --at-all / --at-users / --at-mobiles 仅在 --group 群聊时生效；当设置--at-all时，消息内容中一定要包含对应的占位符<@all>；当设置--at-users userId1,userId2时，消息内容中一定要包含对应格式的占位符<@userId1> <@userId2>
  - --media-id 指定图片 mediaId 时自动发送图片消息（msgType=image），不需要传 --text；图片单聊仅支持 --open-dingtalk-id，不支持 --user
  - 发送钉盘文件消息：传 --dentry-id + --space-id（必要时配合 --file-name / --file-size / --file-type），msg-type 自动推断为 file
```

---

## message list — 拉取会话消息内容

拉取指定群聊或单聊的会话消息内容。**仅支持 `--group + openConversationId`**——单聊会话本身也有 openConversationId，传它即可拉双向消息。

> ⚠️ **不要用 `--user` / `--open-dingtalk-id` 拉单聊**：这两个 flag 虽然能填写但**静默返回 0 条**，是 CLI 路由 bug（详见上文「陷阱合集 #5」）。拉单聊双向消息请用 `dws mcp chat list_individual_chat_message` 或先用 `list-by-sender` 取单聊 openConversationId 再走 `--group`。

```
Usage:
  dws chat message list [flags]
Example:
  # 拉取群聊中某个时间点之后的消息
  dws chat message list --group <openconversation_id> --time "2025-03-01 00:00:00"
  # 拉取单聊双向消息（用单聊 openConversationId，可通过 list-by-sender 或 conversation-info 获取）
  dws chat message list --group <单聊openConversationId> --time "2025-03-01 00:00:00" --limit 50
  # 拉取某个时间点之前的消息（向过去翻页）
  dws chat message list --group <openconversation_id> --time "2025-03-01 00:00:00" --forward=false
Flags:
      --forward                  true=拉给定时间之后的消息，false=拉给定时间之前的消息 (default true)
      --group string             会话 openConversationId（群聊或单聊均可）
      --limit int                返回数量，不传则不限制
      --time string              开始时间，格式: yyyy-MM-dd HH:mm:ss（不传则默认拉取最新消息）
      --user string              ⚠️ CLI bug：静默返回空，不要使用，见陷阱合集 #5
      --open-dingtalk-id string  ⚠️ CLI bug：静默返回空，不要使用，见陷阱合集 #5

注意:
  - **群聊和单聊都用 `--group + openConversationId`**——单聊的 openConversationId 形如 `cid...=`，可通过 `list-by-sender` 或 `conversation-info --open-dingtalk-id` 获取
  - --group 的别名: --id, --chat, --conversation-id (均可替代 --group)
  - 如果返回的会话消息中包含 openConvThreadId 字段，说明是话题类消息，需要调用 dws chat message list-topic-replies 拉取话题的回复内容列表，openConvThreadId 作为 --topic-id 参数
  - **空返回排错**：如果用了 `--user`/`--open-dingtalk-id` 得到 0 条，**不要怀疑"对方没聊过"**——改用 `dws mcp chat list_individual_chat_message --json '{"userId":"...","time":"...","forward":true,"limit":100}'` 或先 `list-by-sender` 拿 openConversationId
```

### 分页翻页说明（重要）

`message list` 的翻页方式与 `message list-all` **完全不同**，请勿混淆：

| 命令 | 翻页参数 | 翻页值来源 | 值格式 |
|------|---------|-----------|--------|
| `message list` | `--time` | 上一页结果中**最后一条消息的 `createTime` 字段** | `yyyy-MM-dd HH:mm:ss`（如 `"2025-03-01 14:30:00"`） |
| `message list-all` | `--cursor` | 上一页响应中的 `nextCursor` 字段 | 字符串（如 `"abc123token"`） |

**翻页步骤（message list）：**

1. **首次请求**：指定起始时间
   ```bash
   dws chat message list --group <id> --time "2025-03-01 00:00:00" --limit 50 --format json
   ```
2. **检查响应**：查看 `hasMore` 字段
   - `hasMore: false` → 没有更多消息，翻页结束
   - `hasMore: true` → 还有更多消息，继续下一步
3. **获取翻页时间**：取返回结果中**最后一条消息**的 `createTime` 字段值（如 `"2025-03-01 14:30:00"`）
4. **下一页请求**：将该 `createTime` 作为 `--time` 传入
   ```bash
   dws chat message list --group <id> --time "2025-03-01 14:30:00" --limit 50 --format json
   ```
5. 重复步骤 2-4 直到 `hasMore: false`

> ⚠️ **常见错误**：
> - **不要把 `nextCursor` 传给 `--time`**：响应中的 `nextCursor` 字段（纯数字时间戳如 `1776684611219`）**不是给 `--time` 用的**。`--time` 只接受 `yyyy-MM-dd HH:mm:ss` 格式。将 `nextCursor` 传给 `--time` 会导致返回相同页面，陷入死循环。`nextCursor` 仅用于 `message list-all` 的 `--cursor` 参数。
> - **不要把 `nextCursor` 传给 `--forward`**：`--forward` 只接受 `true`（拉给定时间之后的消息）或 `false`（拉给定时间之前的消息），不是时间戳或游标参数。

---

## message list-all — 拉取指定时间范围内当前用户的所有会话消息

分页拉取当前登录用户在指定时间范围内的所有会话消息。

--start 和 --end 限定时间范围，--limit 指定每页数量，--cursor 传分页游标（首页传 "0"，后续从响应中的 nextCursor 获取）。

```
Usage:
  dws chat message list-all [flags]
Example:
  dws chat message list-all --start "2025-03-01 00:00:00" --end "2025-03-31 23:59:59" --limit 50
  dws chat message list-all --start "2025-03-01 00:00:00" --end "2025-03-31 23:59:59" --limit 50 --cursor "abc123token"
Flags:
      --start string    起始时间，格式: yyyy-MM-dd HH:mm:ss (必填)
      --end string      结束时间，格式: yyyy-MM-dd HH:mm:ss (必填)
      --limit int       每页返回数量（默认 50）
      --cursor string   分页游标（首页传 "0"，后续从响应中的 nextCursor 获取）

注意:
  - 四个参数每次请求都会传递给服务端，cursor 首页传 "0"
  - 与 chat message list 的区别：list 拉取指定单个会话（群聊或单聊）的消息，list-all 拉取当前用户所有会话的消息
  - 翻页：hasMore=true 时，用响应中的 nextCursor 值作为下次 --cursor 参数继续翻页
  - 时间格式统一为 yyyy-MM-dd HH:mm:ss
```

---

## message list-topic-replies — 拉取群话题回复消息列表

查询指定群聊中某条话题消息的全部回复。--group 指定群会话 ID，--topic-id 指定话题 ID（由 dws chat message list 返回）。

```
Usage:
  dws chat message list-topic-replies [flags]
Example:
  dws chat message list-topic-replies --group <openconversation_id> --topic-id <topicId>
  dws chat message list-topic-replies --group <openconversation_id> --topic-id <topicId> --time "2025-03-01 00:00:00" --limit 20
Flags:
      --group string      群会话 openconversationId (必填)
      --topic-id string   话题 ID，由 dws chat message list 返回 (必填)
      --time string       开始时间，格式: yyyy-MM-dd HH:mm:ss（可选）
      --limit int         返回数量（默认 50）
      --forward           true=从老往新，false=从新往老（默认 false）
```

---

## message list-by-sender — 拉取指定发送者的消息

搜索特定人发送给我的消息，返回结果包含单聊和群聊标识。--sender-user-id 指定发送者 userId，--sender-open-dingtalk-id 指定发送者 openDingTalkId，二者互斥。

```
Usage:
  dws chat message list-by-sender [flags]
Example:
  dws chat message list-by-sender --sender-user-id <userId> --start "2026-03-10T00:00:00+08:00" --end "2026-03-11T00:00:00+08:00" --limit 50 --cursor 0
  dws chat message list-by-sender --sender-open-dingtalk-id <openDingTalkId> --start "2026-03-10T00:00:00+08:00" --end "2026-03-11T00:00:00+08:00" --limit 50 --cursor 0
Flags:
      --sender-user-id string              发送者 userId（与 --sender-open-dingtalk-id 二选一）
      --sender-open-dingtalk-id string     发送者 openDingTalkId（与 --sender-user-id 二选一）
      --start string                       开始时间，ISO-8601 格式 (必填)
      --end string                         结束时间，ISO-8601 格式 (必填)
      --limit int                          每页返回数量（默认 50）
      --cursor string                      分页游标（默认 "0"，翻页传 nextCursor）

注意:
  - --sender-user-id 和 --sender-open-dingtalk-id 二者互斥，必须且只能指定其一
  - 不需要指定单聊/群聊，MCP 返回结果自带会话类型标识
  - 时间支持多种 ISO-8601 格式，如 "2026-03-10T00:00:00+08:00"、"2026-03-10 14:00:00" 等
  - 翻页：hasMore=true 时，用返回的 nextCursor 作为下次 --cursor
```

---

## message list-mentions — 拉取 @我 的消息

搜索时间范围内 @我 的消息，可选指定群聊。

```
Usage:
  dws chat message list-mentions [flags]
Example:
  dws chat message list-mentions --start "2026-03-10T00:00:00+08:00" --end "2026-03-11T00:00:00+08:00" --limit 50 --cursor 0
  dws chat message list-mentions --group <openconversation_id> --start "2026-03-10T00:00:00+08:00" --end "2026-03-11T00:00:00+08:00" --limit 50 --cursor 0
Flags:
      --group string    群聊 openconversation_id（可选，不传则查全部）
      --start string    开始时间，ISO-8601 格式 (必填)
      --end string      结束时间，ISO-8601 格式 (必填)
      --limit int       每页返回数量（默认 50）
      --cursor string   分页游标（默认 "0"，翻页传 nextCursor）

注意:
  - --group 可选，不传则查询所有会话中 @我 的消息；传入则只查指定群聊
  - --group 的别名: --id, --chat, --conversation-id (均可替代 --group)
  - 翻页：hasMore=true 时，用返回的 nextCursor 作为下次 --cursor
```

---

## message list-focused — 拉取特别关注人的消息

拉取当前用户特别关注人的消息。

```
Usage:
  dws chat message list-focused [flags]
Example:
  dws chat message list-focused --limit 50
  dws chat message list-focused --limit 20 --cursor <nextCursor>
Flags:
      --limit int       每页返回数量（默认 50）
      --cursor int64    分页游标（首次不传或传 0，翻页传 nextCursor）

注意:
  - 首次调用不传 --cursor 或传 0，后续翻页传 nextCursor
```

---

## message list-unread-conversations — 获取未读会话列表

获取当前用户有未读消息的会话信息。可选通过 `--count` 限制返回条数。

```
Usage:
  dws chat message list-unread-conversations [flags]
Example:
  dws chat message list-unread-conversations
  dws chat message list-unread-conversations --count 20
Flags:
      --count int    返回未读会话条数（可选）
```

---

## message search — 按关键词搜索消息

在当前用户的会话中按关键词搜索消息。--keyword 必填，可选 --group 限定搜索某个会话。

```
Usage:
  dws chat message search [flags]
Example:
  dws chat message search --keyword "changefree" --start "2026-04-01T00:00:00+08:00" --end "2026-04-15T00:00:00+08:00" --limit 50 --cursor 0
  dws chat message search --keyword "codereview" --group <openconversation_id> --start "2026-04-01T00:00:00+08:00" --end "2026-04-15T00:00:00+08:00" --limit 100 --cursor 0
Flags:
      --keyword string   搜索关键词 (必填)
      --group string     群聊 openconversation_id（可选，不传则搜索所有会话）
      --start string     开始时间，ISO-8601 格式 (必填)
      --end string       结束时间，ISO-8601 格式 (必填)
      --limit int        每页返回数量（默认 100）
      --cursor string    分页游标（默认 "0"，翻页传 nextCursor）

注意:
  - --group 可选，不传则搜索所有会话中的消息；传入则只搜索指定会话
  - --group 的别名: --id, --chat, --conversation-id (均可替代 --group)
  - 翻页：hasMore=true 时，用返回的 nextCursor 作为下次 --cursor
```

---

## conversation-info — 获取会话基础信息

按会话 ID 获取单聊或群聊的基础元数据（名称、类型、成员数等）。在对会话执行操作前用来确认上下文。

```
Usage:
  dws chat conversation-info [flags]
Example:
  dws chat conversation-info --group <openConversationId>
  dws chat conversation-info --open-dingtalk-id <openDingTalkId>
Flags:
      --group string             群聊会话 ID openConversationId（与 --open-dingtalk-id 二选一）
      --open-dingtalk-id string  用户 openDingTalkId（单聊时与 --group 二选一）

注意:
  - --group（群聊 openConversationId）和 --open-dingtalk-id（单聊用户 openDingTalkId）二选一
```

---

## list-top-conversations — 拉取置顶会话列表

拉取当前用户的置顶会话列表。

```
Usage:
  dws chat list-top-conversations [flags]
Example:
  dws chat list-top-conversations --limit 1000
  dws chat list-top-conversations --limit 1000 --cursor <nextCursor>
Flags:
      --limit int        每页返回数量（默认 1000）
      --cursor int       分页游标（首次不传或传 0，翻页传 nextCursor）

注意:
  - 用户询问"置顶会话"时，直接调用此命令返回置顶会话列表即可
  - 用户询问"置顶消息"时，需两步：先调用此命令拉取置顶会话列表获取各会话的 openConversationId，再用 `chat message list --group <openConversationId>` 分别拉取每个会话内的消息
  - 翻页：hasMore=true 时，用返回的 nextCursor 作为下次 --cursor
```

---

## bot search — 搜索我的机器人

```
Usage:
  dws chat bot search [flags]
Example:
  dws chat bot search --page 1
  dws chat bot search --page 1 --size 10 --name "日报"
Flags:
      --name string   按名称搜索
      --page int      页码，从1开始 (默认 1)
      --size int      每页条数 (默认 50)，别名: --limit
```

---

## message send-by-bot — 机器人发消息

群聊：传 --group 指定群；单聊：传 --users 指定用户列表，二者只能选其一，不能同时指定。--text 支持 Markdown。

> ⚠️ **三个硬约束（详见上文「重要陷阱合集 §3、§4、§6」）**：
> 1. **`--group` 模式前置**：机器人必须**先在该群里**，否则 API 返回误导性的 `robot 不存在`。必须先 `group members add-bot` 入群再发。
> 2. **不支持任何 @ 操作**：text 里写 `<@all>` / `<@userId>` 占位符**字面显示**，不会触发钉钉强提醒。需要 @ 能力请改用 `send-by-webhook`。
> 3. **撞 `endpoint not resolved for product "bot"` 立即降级 mcp 直调**：CLI alias bug，cache refresh 无效，按陷阱合集 §6 改用 `dws mcp group batch_send_robot_msg_to_users --json '{...}'`。

```
Usage:
  dws chat message send-by-bot [flags]
Example:
  dws chat message send-by-bot --robot-code <robot-code> --group <openconversation_id> --title "日报" --text "## 今日完成..."
  dws chat message send-by-bot --robot-code <robot-code> --users userId1,userId2 --title "提醒" --text "请提交周报"
Flags:
      --group string        群聊 openConversationId（群聊时必填）
      --robot-code string   机器人 Code (必填)
      --text string         消息内容 Markdown (必填)
      --title string        消息标题 (必填)
      --users string        用户 userId 列表，逗号分隔，最多20个（单聊时必填）

注意:
  - --group 与 --users 互斥，必须且只能指定其一
  - --group 的别名: --id, --chat, --conversation-id (均可替代 --group)
```

---

## message recall-by-bot — 机器人撤回消息

群聊：传 --group 与 --keys；单聊：仅传 --keys。--keys 为发送时返回的 processQueryKey 列表，逗号分隔。

```
Usage:
  dws chat message recall-by-bot [flags]
Example:
  dws chat message recall-by-bot --robot-code <robot-code> --group <openconversation_id> --keys <process-query-key>
  dws chat message recall-by-bot --robot-code <robot-code> --keys key1,key2
Flags:
      --group string        群聊 openConversationId（群聊撤回时必填）
      --keys string         消息 processQueryKey 列表，逗号分隔 (必填)
      --robot-code string   机器人 Code (必填)
```

---

## message send-by-webhook — 自定义机器人 Webhook 发消息

@ 人时需在 --text 中包含 @userId 或 @手机号，否则 @ 不生效。

```
Usage:
  dws chat message send-by-webhook [flags]
Example:
  dws chat message send-by-webhook --token <webhook-token> --title "告警" --text "CPU 超 90%" --at-all
  dws chat message send-by-webhook --token <webhook-token> --title "test" --text "hi @118785" --at-users 118785
Flags:
      --at-all              @ 所有人
      --at-mobiles string   @ 指定手机号，逗号分隔
      --at-users string     @ 指定用户，逗号分隔（需在 text 中包含 @userId）
      --text string         消息内容 (必填)
      --title string        消息标题 (必填)
      --token string        Webhook Token (必填)
```

---

## 意图判断

用户说"建群/创建群聊" → `chat group create`
用户说"搜索群/找群" → `chat search`
用户说"群成员/看群里有谁" → `chat group members list`
用户说"拉人进群/加群成员" → `chat group members add`
用户说"踢人/移除群成员" → `chat group members remove`
用户说"加机器人到群" → `chat group members add-bot`
用户说"改群名" → `chat group rename`
用户说"聊天记录/会话消息/拉取会话" → `chat message list`
用户说"某人发给我的消息/指定发送者/某人的消息" → `chat message list-by-sender`（用户未明确说"单聊"时优先使用，跨单聊/群聊）
用户说"拉取和某人的单聊记录/单聊消息" → `dws mcp chat list_individual_chat_message --json '{"userId":"...","time":"...","forward":true,"limit":100}'`（单步拉双向消息）；或两步走：`list-by-sender` 拿单聊 openConversationId → `chat message list --group <openConversationId>`。⚠️ 不要用 `chat message list --user` —— 是 CLI bug，静默返回空
用户说"@我的消息/at我的/提及我的" → `chat message list-mentions`
用户说"未读消息会话/未读会话列表/我的未读会话" → `chat message list-unread-conversations`
用户说"发群消息(以个人身份)" → `chat message send --group`
用户说"发单聊消息(以个人身份)" → `chat message send --user`（有 userId 时）或 `chat message send --open-dingtalk-id`（有 openDingTalkId 时）
用户说"机器人发消息/机器人群发" → `chat message send-by-bot`
用户说"机器人撤回消息" → `chat message recall-by-bot`
用户说"Webhook 发消息/告警消息" → `chat message send-by-webhook`
用户说"话题回复/群话题消息回复/拉取话题回复" → `chat message list-topic-replies`
用户说"所有消息/全部会话消息/拉取全部消息/时间范围内消息/我的消息/我今天的消息/查我的钉钉消息/最近的消息" → `chat message list-all`
用户说"特别关注人的消息/关注的人的消息/星标联系人的消息" → `chat message list-focused`
用户说"查看我的机器人" → `chat bot search`
用户说"搜索消息/查找关键词/搜一下消息里的XX" → `chat message search`
用户说"我和XX的共同群/我们都在哪些群/查共同群" → `chat search-common`
用户说"置顶会话/置顶消息/我的置顶/查看置顶" → `chat list-top-conversations`
用户说"获取会话信息/会话详情/会话元数据" → `chat conversation-info`

关键区分:
- `chat message list` — 拉取指定会话的消息（用 `--group + openConversationId`，群聊单聊均可），按时间点 + 方向翻页
- 拉取与某人的单聊双向消息 → 用 `dws mcp chat list_individual_chat_message --json '{"userId":"...","time":"...","forward":true,"limit":100}'`（单步），或先 `list-by-sender` 拿 openConversationId 再 `list --group`（两步）。⚠️ `chat message list --user` / `--open-dingtalk-id` 是 CLI bug，静默返回空，不要使用
- `chat message list-by-sender` — 搜索指定发送者发给我的消息，跨所有会话（单聊+群聊均包含，用户只说"某人发的消息"时优先使用）
- `chat message list-mentions` — 拉取 @我 的消息（跨单聊/群聊，可选指定群）
- `chat message list-unread-conversations` — 拉取当前用户存在未读消息的会话列表（可选 `--count`）
- `chat message list-all` — 拉取当前用户所有会话的消息，按时间范围 + cursor 分页。只要用户没有指定某个具体的会话（如某个群名、某个人名），即使提到"单聊消息""群聊消息"等笼统范围，也应路由到此命令
- `chat message list-topic-replies` — 拉取群话题的回复消息列表
- `chat message list-focused` — 拉取特别关注人的消息，cursor 分页
- `chat list-top-conversations` — 拉取置顶会话列表（用户询问"置顶会话"或"置顶消息"时路由到此），cursor 分页
- `chat message send` — 以**当前用户**身份发消息（群聊或单聊），text 为位置参数；支持 --media-id 发送图片消息
- `chat message search` — 按关键词搜索消息内容（跨所有会话，可选指定群）
- `chat search-common` — 搜索共同群，查询指定人共同所在的群聊（AND=所有人都在，OR=任一人在）
- `chat message send-by-bot` — 以**机器人**身份发消息（群聊或单聊），text 为 --text flag
- `chat message send-by-webhook` — 通过**自定义机器人 Webhook** 发群消息
- `chat message recall-by-bot` — 通过机器人撤回已发送的消息
- `chat conversation-info` — 按会话 ID 获取单聊/群聊的基础元数据（名称、类型、成员数等）
- `chat bot search` — 搜索当前用户名下的机器人，拿到 robotCode 用于 send-by-bot / recall-by-bot / group members add-bot

## 核心工作流

```bash
# 1. 搜索群 — 提取 openconversation_id
dws chat search --query "项目冲刺" --format json

# 2. 拉取群消息
dws chat message list --group <openconversation_id> --time "2025-03-01 00:00:00" --format json

# 2b. 拉取未读会话列表
dws chat message list-unread-conversations --count 20 --format json

# 3. 以个人身份发送群消息
dws chat message send --group <openconversation_id> --title "周报提醒" "请大家本周五前提交周报" --format json

# 4. 以个人身份单聊（通过 userId）
dws chat message send --user <userId> --title "问候" "你好" --format json

# 4b. 以个人身份单聊（通过 openDingTalkId，三方应用等无法获取 userId 时使用）
dws chat message send --open-dingtalk-id <openDingTalkId> --title "问候" "你好" --format json

# 5. 机器人发群消息（Markdown）
dws chat message send-by-bot --robot-code <robot-code> \
  --group <openconversation_id> --title "日报" --text "## 今日完成..." --format json

# 6. 机器人单聊发消息
dws chat message send-by-bot --robot-code <robot-code> \
  --users userId1,userId2 --title "提醒" --text "请提交周报" --format json

# 7. Webhook 发告警
dws chat message send-by-webhook --token <webhook-token> \
  --title "告警" --text "CPU 超 90%" --at-all --format json
```

## 复合工作流

### 机器人发消息后撤回（完整流程）

撤回只能用于 `send-by-bot` 发出的消息。个人身份 (`chat message send`) 发出的消息**无法通过 API 撤回**。

```bash
# Step 1: 查我的机器人 — 提取 robot-code
dws chat bot search --format json

# Step 2: 用机器人发消息 — 提取返回中的 processQueryKey
dws chat message send-by-bot --robot-code <robot-code> --group <openconversation_id> \
  --title "通知" --text "内容" --format json

# Step 3: 用同一个 robot-code + processQueryKey 撤回
dws chat message recall-by-bot --robot-code <robot-code> --group <openconversation_id> \
  --keys <processQueryKey> --format json
```

### 将已有机器人加入群并发消息（完整流程）

机器人需先在钉钉开放平台创建好，这里只做"找机器人 → 加入群 → 发消息"。

```bash
# Step 1: 搜索我的机器人 — 提取 robotCode
dws chat bot search --name "项目提醒" --format json

# Step 2: 搜索群 — 提取 openConversationId
dws chat search --query "项目群" --format json

# Step 3: 将机器人添加到群（需当前用户对该群有管理权限）
dws chat group members add-bot --id <openConversationId> --robot-code <robotCode> --format json

# Step 4: 机器人发消息
dws chat message send-by-bot --robot-code <robotCode> --group <openConversationId> \
  --title "提醒" --text "请及时更新项目状态" --format json
```

### 机器人发群消息要 @ 人 → 必须改用 Webhook（应用机器人不支持 @）

> ⚠️ **历史误导已修正（2026-05-17）**：旧版文档曾建议 `send-by-bot --text "<@userId> ..."` 来 @ 人，**这是错的**。`bot.send_robot_group_message` schema 没有任何 @ 字段，占位符会原样字面显示。详见上文「重要陷阱合集 §4」。

**正确做法**：在目标群里**添加一个 Webhook 自定义机器人**（钉钉客户端：群设置 → 智能群助手 → 添加机器人 → 自定义），拿到 webhook token 后用：

```bash
# @所有人
dws chat message send-by-webhook --token <webhook-token> \
  --title "通知" --text "请查收本周报告" --at-all --format json

# @指定个人（text 中必须包含 @userId 字面字符）
dws chat message send-by-webhook --token <webhook-token> \
  --title "提醒" --text "@userId1 @userId2 请查收本周报告" \
  --at-users userId1,userId2 --format json
```

如果你坚持用**应用机器人**（如统一身份/品牌一致性需要），只能在 markdown 文字里写"@张三"作为普通文本（不会触发钉钉强提醒），或在文案前用 `dws chat message send --at-all`（个人代发 + 真 @）然后让机器人补一条详情。

### 发送图片/文件消息（跨产品: drive → chat）

```bash
# Step 1: 上传文件到钉盘 — 获取 uploadId 和凭证
dws drive upload-info --file-name "截图.png" --file-size <字节数> --format json

# Step 2: HTTP PUT 上传文件到 OSS
curl -X PUT -T "截图.png" "<upload-info 返回的上传 URL>"

# Step 3: 提交上传 — 获取 dentryUuid
dws drive commit --file-name "截图.png" --file-size <字节数> --upload-id <uploadId> --format json

# Step 4: 获取下载链接
dws drive download --file-id <dentryUuid> --format json

# Step 5: 用 Markdown 图片语法发送
dws chat message send --group <openconversation_id> \
  --title "截图" --text "![截图](下载链接)" --format json
```

## 上下文传递表

| 操作 | 从返回中提取 | 用于 |
|------|-------------|------|
| `chat search` | `openConversationId` | message send/list、group members 等的 --group |
| `chat group create` | `openConversationId` | 同上 |
| `chat message list-all` | `nextCursor` | 下次 list-all 的 --cursor |
| `aisearch person` | `userId` | message send 的 --user、--at-users、send-by-bot 的 --users、list-by-sender 的 --sender-user-id |
| `aisearch person` → `contact user get` | `openDingTalkId` | list-by-sender 的 --sender-open-dingtalk-id、message send/list 的 --open-dingtalk-id |
| `chat bot search` | `robotCode` | send-by-bot / recall-by-bot 的 --robot-code、group members add-bot 的 --robot-code |
| `chat message send-by-bot` | `processQueryKey` | recall-by-bot 的 --keys |
| `chat conversation-info` | `openConversationId` / 成员信息 | 作为 message send/list 等后续操作的会话上下文确认 |
| `chat message search` | `nextCursor` | 下次 message search 的 --cursor |
| `chat search-common` | `openConversationId` | message send/list 等的 --group |
| `drive download` | 下载链接 | message send 的 Markdown 图片/链接语法 |

## 注意事项

- `--group` 为群聊会话 ID (openconversation_id)，可从群搜索或群聊信息中获取
- `chat message send` 的 text 是位置参数（恰好 1 个），非 flag；群聊用 `--group`，单聊用 `--user`（userId）或 `--open-dingtalk-id`（openDingTalkId），三者互斥；`--at-all`、`--at-users` 仅在 `--group` 群聊时生效；发送图片消息用 `--media-id`
- `chat message list-all` 的四个参数（--start、--end、--limit、--cursor）每次请求都必须传递；翻页时用响应中的 nextCursor 值作为下次 --cursor
- `chat message list` 用 `--group + openConversationId` 拉群聊或单聊会话消息；单聊 openConversationId 可通过 `list-by-sender` 或 `conversation-info --open-dingtalk-id` 获取。⚠️ 不要用 `--user` / `--open-dingtalk-id`（CLI bug，静默返回空，见陷阱合集 #5）
- `chat message list-by-sender` 不需要指定单聊/群聊，返回结果自带会话类型标识
- `chat message list-mentions` 可选 `--group` 指定群聊，不传则查全部
- `chat message list-unread-conversations` 获取当前用户未读会话列表，可选 `--count` 指定返回条数
- `chat message search` 按关键词搜索消息内容，`--keyword` 必填，可选 `--group` 限定搜索某个会话
- `chat search-common` 搜索共同群，`--nicks` 传人员昵称（逗号分隔），`--match-mode` AND/OR 控制匹配逻辑
- `chat list-top-conversations` 拉取置顶会话列表，分页用 `--limit`（默认 1000）/`--cursor`
- `send-by-bot` 群聊传 `--group`，单聊传 `--users`，二者互斥且必选其一
- `recall-by-bot` 群聊传 `--group` + `--keys`，单聊仅传 `--keys`（不传 `--group` 即为单聊撤回）
- `send-by-webhook` 支持 `--at-all`、`--at-mobiles`、`--at-users` 进行 @ 操作，但需在 `--text` 中包含 `@userId` 或 `@手机号` 才能生效

## 相关产品

- [contact](./contact.md) — 搜索同事/好友，获取 userId 用于 --user、--at-users、send-by-bot --users、list-by-sender --sender-user-id；获取 openDingTalkId 用于 list-by-sender --sender-open-dingtalk-id、--open-dingtalk-id
- [drive](./drive.md) — 上传文件获取下载链接，用于 Markdown 图片/文件消息

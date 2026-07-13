---
name: cron
description: 管理定时任务（创建、查看、编辑、删除、立即执行）。当用户要求创建、修改、查看或删除定时任务、周期提醒、自动化任务时使用此技能。
---

# 定时任务管理

使用两个内置工具：

- **`CronList`** — 查询。不传 `id` 列出当前用户全部任务；传 `id` 返回单个任务详情。
- **`CronManage`** — 变更。通过 `action` 字段区分操作：`create` / `update` / `delete` / `run`。

不存在 `mcp__cron__manage` 之类的 MCP 工具，不要通过 Shell 寻找或调用任何 cron 命令行；只用上面两个工具。

## 查询

```json
CronList {}                    → 全部任务（含已禁用）
CronList {"id": "任务ID"}      → 单个任务详情
```

## 创建

`action=create` 必填：`name` + `schedule` + `payload`。

```json
CronManage {
  "action": "create",
  "name": "每日日报",
  "schedule": {"kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Shanghai"},
  "payload": {"kind": "agentTurn", "message": "请生成今日工作日报"},
  "notify": {"enabled": true, "channel": "web"}
}
```

建议默认带 `notify: {"enabled": true, "channel": "web"}`，否则用户看不到任务完成推送。

## 更新（只传要改的字段）

`action=update` 必填 `id`，其余字段可选。

```json
CronManage {"action": "update", "id": "任务ID", "schedule": {"kind": "cron", "expr": "0 10 * * 1-5", "tz": "Asia/Shanghai"}}
CronManage {"action": "update", "id": "任务ID", "payload": {"model": "gpt-5.5"}}
CronManage {"action": "update", "id": "任务ID", "payload": {"timeoutSeconds": 3600}}
CronManage {"action": "update", "id": "任务ID", "payload": {"kind": "agentTurn", "message": "新的提示词"}}
CronManage {"action": "update", "id": "任务ID", "enabled": false}
```

`payload` 更新规则：

- 可以只传要改的字段；未传 `kind` 时，按当前任务的 payload 类型部分更新。
- 修改 `agentTurn.model` 不需要重传完整 prompt，直接传 `{"payload":{"model":"..."}}`。
- 如果要在 `agentTurn` 与 `systemEvent` 之间切换，必须传完整 payload（如 `{"kind":"agentTurn","message":"..."}` 或 `{"kind":"systemEvent","text":"..."}`）。

## 删除 / 立即执行

```json
CronManage {"action": "delete", "id": "任务ID"}
CronManage {"action": "run", "id": "任务ID"}
```

## schedule 格式

```json
{"kind": "every", "everyMs": 1800000}
{"kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Shanghai"}
{"kind": "at", "atMs": 1709280000000}
```

| 字段 | every | cron | at |
|------|-------|------|----|
| `everyMs` | 必填，间隔毫秒 | — | — |
| `anchorMs` | 可选，对齐锚点 | — | — |
| `expr` | — | 必填，5 字段 cron 表达式 | — |
| `tz` | — | 可选，IANA 时区 | — |
| `atMs` | — | — | 必填，Unix 毫秒时间戳 |

周期任务优先用 `cron` 表达式 + `"tz": "Asia/Shanghai"`（避免服务器时区歧义）；一次性任务用 `at`（注意 `atMs` 是毫秒时间戳，先确认当前时间再计算）。

## payload 格式

```json
{"kind": "agentTurn", "message": "你要 Agent 做的事情"}
{"kind": "systemEvent", "text": "系统通知文本"}
```

`agentTurn` 会在任务触发时以任务主人身份新建一个 Agent 会话执行 `message`——提醒、日报、巡检等一切「到点让 Agent 干活」的需求都用它。`systemEvent` 只发一条纯文本通知。

agentTurn 可选字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型覆盖 |
| `maxTurns` | number | 最大轮次 |
| `timeoutSeconds` | number | 超时秒数 |
| `context` | object | 上下文注入配置（见下） |

### context 格式（可选）

控制 Agent 执行时加载哪些上下文。所有字段默认 `true`，省略 `context` 等同于全部加载。

```json
{"systemPrompt": true, "persona": true, "memory": true}
```

| 字段 | 说明 |
|------|------|
| `systemPrompt` | 是否加载系统提示语（关闭后 Agent 退化为最简助手） |
| `persona` | 是否加载用户自定义人格（PERSONA.md） |
| `memory` | 是否加载 MEMORY.md 长期记忆 |

示例：纯工具执行任务，不需要人格和记忆：

```json
{"kind": "agentTurn", "message": "检查服务器状态", "context": {"persona": false, "memory": false}}
```

## notify 格式（可选，建议默认 web）

```json
{"enabled": true, "channel": "web"}
{"enabled": true, "channel": "dingtalk", "dingtalk": {"mode": "user", "userId": "xxx"}}
{"enabled": true, "channel": "dingtalk", "dingtalk": {"mode": "chat", "chatId": "xxx"}}
{"enabled": true, "channel": "both", "dingtalk": {"mode": "user", "userId": "xxx"}}
```

可选：`onSuccess`（成功时通知，默认 true）、`onError`（失败时通知，默认 true）。

钉钉通道的 `userId`/`chatId` 必须由用户明确提供，不要猜测或自行填写。

## 完整示例

### 每天上午 9 点提醒

```json
CronManage {
  "action": "create",
  "name": "每日测试提醒",
  "schedule": {"kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai"},
  "payload": {"kind": "agentTurn", "message": "请简短提醒用户：测试提醒已到达。"},
  "notify": {"enabled": true, "channel": "web"}
}
```

### 每小时巡检 + 失败钉钉通知

```json
CronManage {
  "action": "create",
  "name": "服务巡检",
  "schedule": {"kind": "every", "everyMs": 3600000},
  "payload": {"kind": "agentTurn", "message": "检查所有服务运行状态，发现异常时报告"},
  "notify": {"enabled": true, "channel": "dingtalk", "dingtalk": {"mode": "user", "userId": "manager001"}, "onSuccess": false, "onError": true}
}
```

## 注意事项

- 时间戳均为毫秒级 Unix timestamp
- cron 表达式为标准 5 字段格式（分 时 日 月 周）
- `owner` 由系统自动注入（从会话上下文获取），无需手动传入
- `CronList` 只返回你有权查看的任务，`update`/`delete`/`run` 只能操作自己的任务
- 创建成功后向用户复述：任务名、触发时间（人话，如「每天上午 9 点」）、做什么、如何收到结果

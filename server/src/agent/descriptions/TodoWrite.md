维护当前会话对用户可见的任务/业务步骤列表。
用于非平凡的多步骤工作（通常 3 步以上真实步骤）、多个用户请求、用户明确要求 todo/checklist，或需要在会话里持续展示业务阶段时。
不要用于单步、琐碎或纯信息性请求，也不要在每次工具调用后都更新。

每次调用发送完整列表并整体替换上一版；工作全部完成并汇报后，普通任务列表发送 `todos: []` 清空。
基础字段：`content`、`status`、可选 `activeForm`。旧的简洁 Todo 不需要其他字段。
`status` 可用：`pending`、`in_progress`、`waiting`、`blocked`、`completed`、`failed`。仍在自动执行时保持恰好一项 `in_progress`；等待用户、业务阻断或失败时允许没有 `in_progress`。

需要丰富展示真实业务阶段时，设置 `kind: "business"`，并为每项提供稳定且跨更新不变的 `id`。可选字段：
- `detail`：结构化业务摘要行，用于字段、判定、缺口、风险、引用等；
- `display`：只使用无交互的 `callout` / `records` 白名单块；
- `evidenceRefs`：支撑该步骤的真实对象、来源或回执 ID。
普通工具调用会自动折叠归入当时的 `in_progress` 业务步骤，不要为每次工具调用重复更新列表。
审批和人工选择必须使用 AskUserQuestion / permission_request 等真实交互通道，不要在 Todo 中伪造按钮；没有真实依据时不得填写 evidenceRefs，也不得把步骤标成已确认。

任务完全做完后立即标记 `completed`，再把下一项置为 `in_progress`。测试失败、实现不完整、依赖/文件缺失或仍有阻塞/报错时，不得标记 `completed`。移除不再相关的条目。返回持久化后的列表。
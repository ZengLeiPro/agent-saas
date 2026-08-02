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
业务步骤按时间线呈现在会话流中：步骤转为 `in_progress` 时出现开始痕迹；转为 `completed`/`failed`/`blocked`/`waiting` 时，**该次快照携带的 `detail`/`display`/`evidenceRefs` 会作为这一步的业务小结展示**。因此把步骤置为终态的那次调用必须带上该步骤最终、完整的业务内容。
在每个步骤状态变化时更新一次快照即可；步骤进行中的普通工具调用不需要也不应该触发列表更新。
执行中发现新信息导致计划变化时，应新增、删除、重排、拆分或合并步骤；未变化步骤保持原 `id`，不要机械坚持初始计划。
审批和人工选择必须使用 AskUserQuestion / permission_request 等真实交互通道，不要在 Todo 中伪造按钮；没有真实依据时不得填写 evidenceRefs，也不得把步骤标成已确认。

任务完全做完后立即标记 `completed`，再把下一项置为 `in_progress`。测试失败、实现不完整、依赖/文件缺失或仍有阻塞/报错时，不得标记 `completed`。移除不再相关的条目。返回持久化后的列表。
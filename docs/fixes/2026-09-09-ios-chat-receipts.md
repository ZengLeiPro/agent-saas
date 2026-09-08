# iOS 消息回执补充修复

本说明补充同目录 `2026-09-09-ios-chat-delivery-and-ui.md`。

## 已确认的显示/回执缺陷

`mobile/src/hooks/useChatAppState.ts` 原来的 ACK 超时定时器即使已找不到对应 outbox 条目，或者条目已收到确认，仍会把气泡改为失败。发送 Promise 返回后才挂定时器，存在 ACK 先到、随后再挂上过期定时器的顺序风险。

另外，超时会取消本地流挂载，但未挂载时的事件白名单没有 `chat_ack` / `chat_rejected`；迟到的权威发送回执会被丢弃。原来的 ACK 回调只更新 outbox，不直接修复可见气泡状态，失败显示可能一直保留。

## 修复边界

- 将 ACK 截止时间封装为按“具体发送 attempt 对象”拥有的计时器。ACK 先到、条目已删除、重试替换 attempt、会话切换，都会使旧计时器失效。
- 超时保留原始 `clientMsgId` 和 intent，并明确提示“尚未收到发送确认，可重试”。超时不等于服务端拒绝，也不自动产生第二次业务提交。
- 即使本地已不挂载流，也允许与当前可见消息 ID 精确匹配的 ACK / rejection 进入既有共享处理器；其他会话的回执不能修改当前气泡。
- ACK 主动将 pending/failed 气泡恢复到服务端确认的 sent/queued 状态并清理旧失败提示。业务执行完成与消息已接收仍是两个状态。
- 对当前草稿的已知 intent，带有权威 sessionId 的 ACK 可恢复丢失的新会话绑定；不会用另一会话或另一条消息的回执导航。
- 新的 `stream_id` 通过既有防串校验后恢复运行显示。消息发送、回执相关遥测改为尽力记录，遥测异常不得中断提交或吞掉回执。
- 原生传输的迟到失败不再按旧数组下标误伤当前会话的消息。

## 验证

新增 `mobile/src/lib/chatDeliveryReceipt.test.ts` 覆盖 ACK-before-arm、ACK-before-timeout、timeout-then-late-ACK、attempt 移除/替换/切视图、queued 语义、语音回执和真实 hook 接线。测试与构建只在 GitHub Actions 执行；未进行本地或真机验证。

最终 CI 状态应读取 PR 最新提交的检查，不能沿用之前提交的绿色结果。仍需通过正常 iOS 发布流程更新已安装 App，并完成主实施说明中的真机验收。

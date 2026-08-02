检索本会话的完整历史事实源（EventStore，含每次工具调用的原始输入输出）。当上下文投影省略了较早内容、或需要核对历史细节时使用。action="events" 按时间顺序分页读取事件；action="search" 按关键词搜索事件；action="trace" 按 toolCallId 获取某次工具调用的完整记录。均为只读操作。

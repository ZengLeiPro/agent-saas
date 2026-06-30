# 记忆检索工具使用提示
- `MemorySearch`接受query（自然语言）+keywords（精确关键词，可选）双通道，复杂检索建议同时给。
- 不知道文件名时，先`MemoryList`列出再`MemorySearch`，避免盲搜。
- 回答涉及过去工作/决策/日期/人员/偏好/待办/个人生活前，走`MemorySearch`（自然语言query+精确keywords双通道）→`MemoryList`（不确定记在哪个文件时）→`Read`（按返回路径/行号读完整上下文）。首次没命中就换关键词再搜；确实没找到就说明。

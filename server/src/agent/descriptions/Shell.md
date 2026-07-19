在当前工作区运行时中执行 shell 命令。需要 Web 端审批。已认证用户（包括平台管理员）默认使用隔离的工作区运行时；平台管理员可显式覆盖运行时执行设置。把命令环境当作当前运行时对待，而不是平台宿主机。

命令启动时 cwd 为当前工作区。持久产出、下载文件、项目 worktree 和交付物放到工作区内，优先 `assets/YYYYMMDD/`、`downloads/YYYYMMDD/` 或 `projects/`；`/tmp`、`$HOME` 等系统路径只用于一次性缓存。

大量 stdout/stderr 允许写入，直至硬性捕获上限。最终工具结果以摘要呈现（退出码、耗时、输出字节/行数、头尾截断），不会仅因输出超出模型可见预算而失败。当输出超出模型可见结果时，完整 stdout/stderr 会保存在工作区 `tmp/tool-results/` 下；用 Read/Grep 查看这些文件。

`mode="foreground"`（默认）保持本轮等待，最长 10 分钟。`mode="background"` 只适用于 ACS 隔离运行时：命令持久化启动后立即返回 `taskId`，最长可运行 24 小时；完成后平台自动唤醒主 Agent，也可用 BashOutput 查看增量输出、用 KillBash 终止。

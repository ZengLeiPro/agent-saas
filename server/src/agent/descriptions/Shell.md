在当前工作区运行时中执行 shell 命令。需要 Web 端审批。已认证用户（包括平台管理员）默认使用隔离的工作区运行时。把命令环境当作当前运行时对待，而不是平台宿主机。

命令启动时 cwd 为当前工作区。持久产出、下载文件、项目 worktree 和交付物放到工作区内，优先 `assets/YYYYMMDD/`、`downloads/YYYYMMDD/` 或 `projects/`；`/tmp`、`$HOME` 等系统路径只用于一次性缓存。

文件发现优先用 `rg --files`，内容搜索优先用 `rg -n`；`rg` 不可用时再退化到 `find`/`grep`。用目录、文件类型和结果数量限制输出，相关模式尽量合并执行。

Python/venv 能力取决于当前运行时，不要假设一定存在：先检测 `python3`/`pip`；若运行时已提供虚拟环境且 `python3`/`pip` 指向它，装包直接 `pip install xxx`。禁止 `sudo pip`、`pip install --user`、`--break-system-packages`、向系统 Python 安装任何东西、未经用户要求自建新 venv。Python 不可用时说明当前执行环境限制并换方案或请用户确认。

大量 stdout/stderr 允许写入，直至硬性捕获上限。最终工具结果以摘要呈现（退出码、耗时、输出字节/行数、头尾截断），不会仅因输出超出模型可见预算而失败。当输出超出模型可见结果时，完整 stdout/stderr 会保存在工作区 `tmp/tool-results/` 下；用 Read 读取已知结果文件，或用 Shell+`rg -n`继续检索。

`mode="foreground"`（默认）保持本轮等待，最长 10 分钟。`mode="background"` 只适用于 ACS 隔离运行时：命令持久化启动后立即返回 `taskId`，最长可运行 24 小时；完成后平台自动唤醒主 Agent，也可用 BackgroundTask(action="output") 查看增量输出、用 BackgroundTask(action="cancel") 终止。

对依赖安装、测试、typecheck、build 等 I/O 密集型前台验证，可设置 `execution="snapshot"`。平台会自动把 Git 当前提交及未提交改动复制到同一 ACS 容器的临时本地盘，并复用本地包缓存后执行；无需自行 `cp`、`rsync` 或提交代码。临时执行区只用于验证，命令生成的文件不会写回持久工作区；需要保留的源码修改和交付物仍在默认 `execution="workspace"` 下完成。不满足 Git 根目录等条件时会自动回退到持久工作区并在结果 metadata 说明原因；后台命令始终使用持久工作区。

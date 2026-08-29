在当前工作区运行时中执行 shell 命令。除严格只读、仅访问当前工作区相对范围且不启用 hidden/no-ignore/follow 的单段 `rg --no-config --files ...` / `rg --no-config -n ...` 外需要 Web 端审批；符合条件的 `rg` 仅允许省略路径或使用 `.`/`./`，需要收窄范围时用 `-g`/`--glob` 或 `-t`/`--type`，并会跳过 shell 解释器、按 argv 直接执行；复合命令、重定向、管道、变量/通配符展开与其他命令仍按危险操作处理。已认证用户（包括平台管理员）默认使用隔离的工作区运行时。把命令环境当作当前运行时对待，而不是平台宿主机。

命令启动时 cwd 为当前工作区。持久产出、下载文件、项目 worktree 和交付物放到工作区内，优先 `assets/YYYYMMDD/`、`downloads/YYYYMMDD/` 或 `projects/`；`/tmp`、`$HOME` 等系统路径只用于一次性缓存。

文件发现优先用 `rg --no-config --files`，内容搜索优先用 `rg --no-config -n`；`rg` 不可用时再退化到 `find`/`grep`。用目录、文件类型和结果数量限制输出，相关模式尽量合并执行。

Python/venv 能力取决于当前运行时，不要假设一定存在：先检测 `python3`/`pip`；若运行时已提供虚拟环境且 `python3`/`pip` 指向它，装包直接 `pip install xxx`。禁止 `sudo pip`、`pip install --user`、`--break-system-packages`、向系统 Python 安装任何东西、未经用户要求自建新 venv。Python 不可用时说明当前执行环境限制并换方案或请用户确认。

大量 stdout/stderr 不会因超出内存捕获窗口而终止命令：内存只保留头部与滚动尾窗，完整字节流同步写入工作区 `tmp/tool-results/`；仅单通道超过 512 MiB 磁盘配额时才终止。最终工具结果以摘要呈现（退出码、耗时、真实输出字节/行数、头尾窗口、完整文件路径）；用 Read 读取已知结果文件，或用 Shell+`rg -n`继续检索。

`mode="foreground"`（默认）保持本轮等待，最长 10 分钟。`mode="background"` 只适用于 ACS 隔离运行时：命令持久化启动后立即返回 `taskId`，最长可运行 24 小时；完成后平台自动唤醒主 Agent，也可用 BackgroundTask(action="output") 查看增量输出、用 BackgroundTask(action="cancel") 终止。

ACS 隔离运行时中的命令统一由 Bash 执行。`cwd` 是工作区相对目录，适用于持久工作区和临时盘快照；传了 `cwd` 后，命令中不要再重复 `cd` 同一路径。

对依赖安装、测试、typecheck、build 等 I/O 密集型前台验证，可设置 `execution="snapshot"`。平台会自动把 Git 当前提交及未提交改动复制到同一 ACS 容器的临时本地盘，并仅在命令确实需要时复用或准备依赖树；无需自行 `cp`、`rsync`、安装依赖或提交代码。纯测试/typecheck 和带 `--frozen-lockfile` 的依赖恢复即使误选 workspace，也会由平台确定性改道到快照；需要保留构建产物时仍可显式使用 workspace。定向 Vitest 使用 `pnpm -F <包> exec vitest run <包内相对路径>`，不要把文件路径追加到 `pnpm test --`，后者可能误跑完整测试集。多段验证直接使用简单 `&&` 或逐次调用 Shell，不要用 `tee`/`PIPESTATUS`/条件分支包成一个大脚本，否则平台无法安全拆分。`git`、`rg`、`find`、`pwd`、`du`、`ssh` 等读取/诊断命令通常直接使用默认 `execution="workspace"`。临时执行区只用于验证，命令生成的文件不会写回持久工作区；需要保留的源码修改和交付物仍在持久工作区完成。快照无法可靠建立时命令会停止并返回错误，绝不会改在持久工作区执行。后台命令始终使用持久工作区。

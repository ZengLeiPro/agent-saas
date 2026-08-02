管理当前会话的后台任务（Agent(mode=background) 派发的后台 Agent、Shell(mode=background) 启动的后台命令），是后台任务的唯一治理入口。

- `action="list"`：列出当前会话的后台任务及真实运行状态。任务完成后平台会自动唤醒主 Agent，通常无需轮询；仅在需要主动核对时调用。
- `action="status"`：查询单个任务的状态、结果摘要和完整输出文件位置（`task_id` 必填）。
- `action="output"`：续读**运行中后台命令**的增量输出（`task_id` 必填；可用 `stdout_offset`/`stderr_offset` 从上次位置续读，`wait_ms` 等待新输出）。仅命令任务可用；任务进入终态后请改用 `action="status"` 获取结果与输出文件位置。
- `action="cancel"`：取消 pending/running 任务（`task_id` 必填）。命令任务会同时终止 ACS 内的进程；已进终态的任务保持原状态。

读取 `Shell(mode="background")` 返回任务的增量 stdout/stderr 和真实进程状态。用返回的 `nextStdoutOffset`、`nextStderrOffset` 继续读取后续输出；`wait_ms` 可短暂等待新输出，但通常无需频繁轮询，任务完成后平台会自动唤醒主 Agent。

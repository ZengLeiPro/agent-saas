# Web 不可变资源发布：有界并发与超时诊断

## 背景

生产晋级 `rc-20260910-111`（run `34490236777`，job `102914844457`）在
Web 不可变资源上传与校验阶段耗尽了共享的 1200 秒操作预算，退出码为 124。
原有日志没有逐资源进度，不能区分某个请求阻塞与串行请求累计耗时。
Web 入口恢复成功，但 ACS 已升级，因此最终正确地进入 `needs_human`，不能当作整次回滚成功。

## 本次修改

`upload-web-assets-immutable.sh` 保留五个已有位置参数，默认使用 4 个资源 worker。
第 6 个可选参数限制并发数（1–8），第 7 个限制单次子进程时间（1–120 秒，默认 60）。
不新增生产环境变量、不修改 workflow 的 1200 秒操作预算、300 秒回滚预算或主机锁租约。
RC 晋级与人工 Web-only 兼容发布使用同一 helper，修复同时覆盖这两条入口。

每个资源仍独立完成确定性 gzip、禁止覆盖的条件 PUT、SDK HEAD/GET、存储字节比较，
以及正式域名响应头校验。409 仅在确认 `FileAlreadyExists` 后进入复用路径；
既有元数据修复仍由原 helper 的字节与 ETag 门禁保护。不跳过校验，不放宽权限。

子进程由 `timeout --foreground --signal=TERM --kill-after=5` 监管，不创建脱离发布
进程组的后台任务。仅 timeout 的 124 状态最多重试一次；条件 PUT 的成功回执丢失后，
重试产生的 409 仍须通过完整回读。公开 HEAD 另有连接、请求时间限制和最多两次
curl 暂时性错误重试。权限错误、非精确 409、字节不一致及非法响应头均不能变成成功。

任一 worker 失败，调度器停止补充任务，终止并等待其他 worker 及其当前请求退出，
再向调用方返回失败；调用方开始恢复 Web 入口时，不应遗留仍在写 OSS 的 worker。
只有所有资源完成并留下成功回执后，才打印最终 `immutable Web assets verified`。
临时目录在正常、错误和信号退出时清理；日志不打印凭据或完整命令参数。

## 日志与验证

每个请求记录资源键、阶段、尝试次数、请求期限和已用时间；每完成一个资源记录批次进度。
出现失败时，先查看最后的 `Web asset verification failed`，再结合该资源的阶段日志，
不要仅依据最终状态记录步骤判断根因。

新增 `scripts/release/web-asset-pool.test.mjs` 使用真实 Bash worker 和 timeout，
仅替换外部 I/O，覆盖并发上限、回执丢失后复用、各阶段超时、停止调度与取消后的进程回收。
原 `upload-web-assets-immutable.test.mjs` 继续验证真实 SDK helper 和不可变存储契约。
完整 GitHub CI 由现有 `test:release-contracts` 自动收集这两组测试。

本次不自动合并或部署、不调整 `reconcile-promotion.mjs`。恢复此前部分发布前仍须重新
回读在线组件身份，按受控恢复流程决定继续晋级或回退；PR CI 成功不等于生产云端发布已验证。

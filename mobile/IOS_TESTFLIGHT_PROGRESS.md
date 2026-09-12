# TestFlight 上传与等待的进度诊断

## 日志读法

提交脚本按顺序报告 `inspect`、`upload`、`build-visibility`、`apple-processing`、`internal-testflight`。
已有同版本同构建号时不再次上传；上传客户端报错后，仅用 `reconcile-upload` 查询同一构建，
确实已被 Apple 接收才继续处理，不会生成或上传新的 IPA。

每个阶段立即输出 `started`，状态变更立即输出 `state`，等待中每 30 秒输出 `heartbeat`。
每条日志包含阶段、状态、阶段已用秒数、阶段剩余秒数、总剩余秒数和 UTC 截止时间。
每条记录同时包含经过格式校验的 `appId`、`version`、`buildNumber`，便于核对实际查询目标。
阶段结束输出 `completed`、`failed`、`timed-out` 或 `cancelled`，并写入 Actions Summary。

- `upload` 的 `RUNNING` 只表示上传进程仍在运行。`toolOutputBytes` 与
  `lastToolOutputSecondsAgo` 反映工具输出活跃程度，不是上传流量或百分比。
- `upload` 只有退出码为零且存在可识别的成功回执、没有错误内容，才记录 `UPLOAD_REPORTED_SUCCESS`。
  `completed` 不再带含糊的 `RUNNING`；工具成功报告也不等于 Apple 已完成处理。
- `build-visibility` 的 `NOT_VISIBLE` 表示精确构建还未出现在查询结果中；最多等待 15 分钟。
  尚未发现构建时不会进入 `apple-processing`，不会把未知上传结果包装成 Apple 正在处理。
- `apple-processing` 仅在构建已经出现后执行；`PROCESSING` 表示 Apple 正在处理，`VALID` 表示处理完成。
- `internal-testflight` 的 `IN_BETA_TESTING` 才表示内部测试就绪。
  `MISSING_EXPORT_COMPLIANCE`、失败或过期状态会终止，不会伪造发布成功。
- 未识别的 Apple 状态显示 `UNKNOWN`，继续在限定期限内查询，不输出任意服务端文本。

## 上传结果不是只看退出码

Xcode 26 的 altool 存在输出错误却返回零退出码的情况，上游复现见
[fastlane/fastlane#29740](https://github.com/fastlane/fastlane/pull/29740)。
本客户端同时检查进程退出状态和输出内容：

- JSON 的非空 `product-errors` / `errors`、明确失败状态、`ERROR:` 和 `Failed to upload` 等错误优先；
  即使同时有成功文字或进程退出码为零，也拒绝标为成功。
- 正向证据只接受已支持的 altool JSON `success-message` 或独立 `UPLOAD SUCCEEDED` 标记。
  空输出、帮助文字、不可识别结果、残缺 JSON、输出超过上限或回执歧义均拒绝直接标为成功。
- stdout/stderr 分开累计并分别计算摘要，持续读取以防阻塞；每个流最多保留 256 KiB，
  错误标记不会被后续大量输出覆盖。不把两个流交错拼接后误读为 JSON。
- `upload-result` 事件及 Actions Summary 保留安全诊断：退出码、固定原因、错误类别、有限错误码、
  固定排查提示、输出字节数/SHA256，以及格式正确时的 delivery UUID。
  不输出完整工具文本、服务器响应、文件路径、JWT、P8 或凭据。

**诊断首先看 Actions 日志和 Summary，不要求 Apple 网页一定能显示失败上传记录。**
`NO_SUCCESS_EVIDENCE` 表示没有成功证据，`TOOL_REPORTED_ERROR` 表示工具返回了明确错误；
后者可结合安全错误码以及 `CHECK_IPA_FILE`、`CHECK_API_CREDENTIALS` 等固定提示定位，
这些提示是分类而非对生产故障原因的断言。

上传工具异常后，只有独立查询确实找到相同应用、版本和构建号，才允许继续核验 Apple 状态；
此时保留 `accepted-before-client-error` 和原失败诊断，不伪造工具成功。只有 `VALID` 且
`IN_BETA_TESTING` 都成立才写最终发布回执；回执新增 `uploadEvidence`，已存在构建无需上传时为 null。

## 传给上传工具的文件

传递真实的私有只读 `upload.ipa` 路径，不再使用进程局部 `/dev/fd/3`。
客户端创建 `0700` 目录、复制出 `0400` 文件，并在上传前后核对源文件及副本 SHA256；
工具启动辅助进程后也能重新打开同一文件。这不是重新打包、重新签名或重新构建。
现有制品哈希、来源、签名及应用身份校验均不放宽。
文件参数兼容性是本次防御性修复，不据此断言历史运行的 745 字节输出包含了何种错误。

## 统一时限与清理

Apple 提交流程共享 **105 分钟**的总预算，使用单调时钟；各阶段的时限不是累加预算。
预检查最多 2 分钟，上传最多 45 分钟，构建出现最多 15 分钟，Apple 处理最多 90 分钟，内部测试最多 30 分钟；
每一阶段实际可用时间都是自身上限和总剩余时间中的较小值。
现有 Actions Job 仍为 120 分钟，预留 15 分钟用于检出、复验、回执上传和清理。
构建出现超时只表示尚未确认，不代表 Apple 明确拒绝；不自动重传。
105 分钟从提交客户端启动时起算；准备阶段异常缓慢时，Job 后备上限仍可能先触发。
HTTP 请求的 30 秒单次时限、重试退避和轮询休眠均服从阶段及总预算。

上传采用异步子进程。阶段超时或 SIGINT/SIGTERM 取消时，先向本次上传进程组发送 SIGTERM，
5 秒内未退出则发送 SIGKILL，并停止心跳、清理本次临时私钥目录、IPA 副本和文件描述符。
取消或总预算耗尽后不继续查询补救或再上传，不写入成功回执。
临时 P8 使用独立 0700 目录、0600 文件，打开 IPA 或启动工具失败也会清理；
P8 原文不继承到上传工具的环境变量中。

## 校验日志

制品校验只根据最外层脚本的最终非零退出打印一次失败阶段。
可选字段不存在、证书数组遍历结束等正常探测不会再触发子 Shell 的失败消息。
真实签名、应用身份、来源、权限、描述文件或证书归属错误仍拒绝，并且不生成校验记录。
原生 macOS 回归要求成功路径没有失败阶段日志、失败路径恰好一条最终失败阶段日志。

## 生效范围与验证

本改动不取消、不重启已在运行的发布，也不新增 Secret 或修改环境规则。
**运行中的任务不会热更新脚本。** 合并后由包含本修复的新 main 构建启动的发布才使用新逻辑。
重试旧 IPA 仍受旧源码绑定约束，可能继续执行原版本的提交脚本；不能仅凭当前 main 已更新，
就声称原制品的重试使用了新版上传程序。

`app-store-connect.test.mjs` 已经在必需移动端测试和 macOS Workflow 中执行，新增用例沿用这些入口。
它们覆盖真实异步子进程、输出排空、进程组终止、临时私钥清理、HTTP 取消、共享截止时间、
状态转换及真实 CLI 的成功/失败/取消回执边界；Apple HTTP 与 xcrun 是本地测试替身。
新增 `app-store-upload-result.test.mjs` 由上述测试入口引入，覆盖零退出码错误、真假回执冲突、
不可识别输出、整条 CLI 不误写成功结果，以及辅助进程重开真实只读文件。
这些回归不是 Apple 真实上传或原运行结果的证明。

```bash
node --test mobile/scripts/app-store-connect.test.mjs
```

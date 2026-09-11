# RC119：生产前置观测、Worker 就绪与恢复

## 事故事实与未证实原因

调查固定基线为 `eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`，不是假定 main 永远停留在该提交。
生产 run `34628618369` / job `103359750870` / attempt 1 在写入前读取生产状态时失败：
`Unable to read production readyfile for runtimeWorker.`；随后记录 `failed_before_change`。
同一 RC119 的 Staging run `34627134019` 在准备生产基线时已经遇到相同错误，随后使用
RC117 的 last_committed 检查点。RC119 清单只部署 Web，API、Worker、ACS 均 keep。

旧代码丢弃文件读取 errno，因此历史错误本身不能区分 ENOENT、EACCES 或其他 I/O 故障。
Worker 会因准入暂停、配置身份不一致、私有快照不可确认或刷新过慢主动撤销 readyfile。
没有该时刻的生产 journal、内存采样和私有状态，本 PR 不把任何一个候选原因定性为线上根因。
旧 Staging 小内存事故不能直接证明这次生产事故也是内存不足。

## 本次修复的代码缺陷

1. ConfigIdentity 原有强一致刷新没有整轮 deadline。其 readyfile watchdog 在 1 秒后撤销就绪，
   但 pending promise 不结束时，后续每秒同步只能被排除，不能进入恢复。本次在整轮只读配置
   观察上设置 20 秒 deadline；失败走既有 generation-fenced 失效与重试路径。原 1 秒 fail-closed
   watchdog 和 5 秒正常重算节流保留。
2. 运行时 readyfile 同步有在途异步刷新。新增可停止的投影器，drain/shutdown 后的旧结果不得
   重新创建 readyfile；快刷新不抖动已有就绪。真实准入、配置一致与私有快照三个条件不变。
3. 前置读取的错误与安全诊断在完整 production-before.json 生成前就被丢失。新增有界只读观测
   与独立诊断输出；原严格 reader 仍是唯一生成权威生产状态的入口。
4. Staging 历史基线回退没有清楚标识当次生产预检失败；前置失败的最终诊断还可能变成 unknown。
   新增基线来源与当前 run/attempt 绑定的 before-change 证据，不通过“缺少 receipt”反推生产未变更。

整轮 timeout 只结束本地对只读结果的等待，不声称已经取消远端请求。迟到成功或失败都不能越过
原 generation fence 提交。配置候选验证超时不发布、不接受新的 expected、不改写生产配置。

## 私有诊断协议

Worker 在现有 readyfile 同目录原子发布 `<readyfile>.status.json`，权限 0600。它不是新的
ready token，不被业务接单端作为授权依据，不加入匿名 health 响应，也不包含配置正文或凭据。

摘要只包含：schemaVersion、进程 PID、bootId、processStartTicks、环境、releaseId、source SHA、
Server digest、采样时间、就绪状态、配置状态、私有快照是否当前、准入原因及白名单数值指标、
配置刷新 pending/slow/耗时。没有 Token、SecretVault ref、任意错误正文、环境变量全集或 journal。

生产观测器分别采样 API/Worker 的 active color、systemd MainPID/状态、pidfile、精确 cgroup、
进程启动 ticks、内容寻址 symlink 与 release.env 的三个非秘密身份字段。Worker 的 readyfile
错误单独保留 errno、文件权限和 owner；配置文件只提取安全状态与 release 绑定。
读取拒绝 symlink/FIFO/device，限制字节数、子进程时间与缓冲，不把 JSON 解析失败片段写入证据。

仅当 sidecar 属于同一个 PID/boot/start/release/digest、root:0600 且采样时间在允许窗口内，
它才可以解释临时失败。旧 Worker 没有 sidecar 时明确标记 reason unavailable，不能猜测内存原因。
原严格 reader 已成功的旧版本不必先拥有新 sidecar，避免诊断协议变成新的上线死锁。

## 发布阶段与重试政策

调用方仍选择 `read-production-state.mjs`（稳态）或 `read-live-production-components.mjs`
（既有中断恢复/候选回读语义）。新包装器只能调用这两个 reader，不能注入任意命令。

- 默认总预算 75 秒、间隔 2 秒、最多 32 次；单次严格 reader 子进程最多 30 秒。
- 仅在严格 reader 明确因 Worker readyfile 失败、身份保持可验证，并有当前私有状态证明是
  内存准入暂停、配置刷新慢/超时，或同代就绪已在采样间隙恢复时，再做有限的只读重观测。
- 权限/I/O 故障、错误 PID、身份变化、配置漂移/不可验证、retention 权威故障、drain、
  未知原因或过期/错进程 sidecar 都不能盲目重试。
- 重试期间活动色、PID、boot、启动 ticks、releaseId、source/digest 任一变化均终止本轮，
  即使之后取得另一代的成功响应，也不把它混入本轮观测。
- 只有原严格 reader 的成功完整输出才能原子 create-only 发布 production state。
  诊断状态、历史 checkpoint 和 Web-only/keep 均不构成发布旁路。

Runner 通过原有固定 SSH 身份，以 `sudo -n` 一致读取主机私有证据。该操作不 chmod 私有文件、
不公开配置摘要、不放宽 SSH host-key pinning、不新增 production secret。失败和成功均尝试取回
诊断；诊断传输失败不冒充 reader 成功，也不覆盖 reader 的原退出码。SSH 自身另有总时限。

受保护的 repair 入口、精确 manifest、ConfigIdentity、组件 digest、生产锁、写入前 gate、
候选就绪、切流、回滚和最终观察门禁保持原语义，不把 repair 当作任意健康故障的通行证。

## 证据与阶段语义

`production-preflight.json` 从 reader 调用前就建立，记录当次 run/attempt 的各次安全观察和结果。
`production-preflight-transfer.json` 记录 reader 与诊断取回的独立退出码。
`promotion-prechange-failure.json` 仅由既有明确在 promoting marker 之前的失败分支产生。
最终摘要重建白名单字段；旧 run/attempt 证据不能用于当前失败结论，真实 reconcile 优先。

`retry_after_change` 的本次预检失败只说明本次还没开始新的生产写入，不证明之前那次没有变更。
证据保留 `scope=current_attempt_only` 与 `priorRecoveryRequired=true`。

Staging 仍可以用 last_committed 准备历史构建基线，但 summary/产物明确显示当次 Production
preflight failed、历史来源、promotionAuthorized=false。真正生产晋级必须重新通过新鲜严格观测。
不将 Staging 的成功篡改为失败，也不将历史基线冒充当前生产健康。

## 验证与线上验收

回归覆盖真实 readyfile 创建/撤销/恢复、慢刷新与总超时、迟到结果、drain fence、重复周期、
身份/权限/新鲜度、有限重试、状态 create-only、诊断脱敏、历史基线来源、当次失败证明及实际
Bash/SSH 传输控制流。ConfigIdentity 挂起测试需要在原始源码上先失败、修复后通过。
沿用仓库正式 CI 与 existing gates，不删除测试、不跳过失败、不采用 continue-on-error。

PR CI 通过不等于线上已经恢复。此 PR 不合并、不触发生产发布、不重启 Worker、不修改内存阈值、
不补写 readyfile、不修改历史 RC/attestation，也不执行业务重放。

上线后的独立验收应记录：一次正常 RC 晋级，正常业务运行并经历多轮配置刷新/准入采样，再执行
第二次独立正常晋级（包含 Web-only、Worker keep）；两次都不得依赖手工补文件、临时 chmod 或
重启后抢时发布。若旧 Worker 缺少 sidecar，应先用本观测器取得 errno/进程/私有配置证据，再按
查明原因做受控恢复。不能为了让新诊断代码上线而跳过旧生产健康门禁。

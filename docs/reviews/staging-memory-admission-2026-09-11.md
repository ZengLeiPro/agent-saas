# Staging 小内存主机准入策略调整

## 事故依据与范围

RC114 的运行 `34543249860` 在部署后验收读取 `/api/healthz/ready` 时得到 503。
用户提供的现场日志显示 Worker 仍在运行、配置身份一致，但 07:56:41 因
`host_mem_available_low` 暂停领取新任务，撤销了 readyfile。当时可用内存为
1171 MiB；后续采样的 MemTotal 为 3674912 KiB，MemAvailable 为 1113736 KiB。
旧规则要求空出 1536 MiB 才不触发暂停，暂停后更要超过 2560 MiB 才能恢复。

本修复只调整明确标识为 `staging` 的内存策略，不清缓存、不加 Swap、不扩容，
不修改主机配置，不增加 Workflow、发布表单或新的环境变量。生产、测试、开发和
缺失环境标识继续使用原来的标准阈值与等待时间。

## 新策略

通过现有 `AGENT_SAAS_ENVIRONMENT` 自动选择，Guard 构造时固定策略。
`environment` 构造参数用于显式依赖注入和测试，并不是新的部署开关。

Staging 宿主机暂停阈值为 `max(512 MiB, MemTotal × 15%)`，恢复阈值为
`max(768 MiB, MemTotal × 25%)`；标准策略仍为 `max(1.5 GiB, MemTotal × 20%)`
与 `max(2.5 GiB, MemTotal × 30%)`。

已经健康的进程仍在持续压力达到 3 秒后暂停。Staging 连续满足全部恢复条件 10 秒后
恢复，标准策略保持 30 秒。Staging 可用内存低于 256 MiB 时立即暂停，不等待防抖。
首个有效样本已经超暂停阈值或有 PSI/cgroup 压力时，Staging 直接暂停，不短暂发布
readyfile；标准策略沿用原有启动判断。

在现场 3.50 GiB 的有效物理内存上，新暂停阈值约 538 MiB，恢复阈值约 897 MiB。
因此约 1.04 GiB 的可用内存不再被 1.5/2.5 GiB 固定下限长期阻断；真正低于新阈值
仍会暂停，并在持续恢复后自动开放准入。正常健康启动无需额外等待，运行中的短暂
低值仍用原 3 秒防抖，不延长发布流程。

这些是根据本次 Staging 资源预算选定的工程策略，不是 Linux 官方推荐阈值，也不构成
任意任务并发或峰值负载都不会 OOM 的保证。绝对下限仍保留，未承诺适配任意小规格主机。

## 保留的保护与语义

- 内存 PSI 的暂停与恢复门槛、Worker cgroup 高水位和可回收 slab 扣除算法不变。
  任何一项独立压力都可暂停；宿主机余量恢复不代表可以忽略仍然存在的 PSI/cgroup 压力。
- MemAvailable 已计入内核对部分可回收缓存的估计，不叠加文件页缓存或 slab，不把 Swap
  计作物理内存余量。参考 Linux `/proc` 文档与 PSI 文档。
- 仅改变是否领取新任务，不取消在途 run，不写虚假 readyfile，不跳过配置身份、
  数据库、Staging 核心验收或生产晋级证据检查。Linux 指标读取失败仍沿用已有处理方式。
- 日志继续输出可用内存和实际阈值，并新增所选策略；恢复日志带实际连续恢复时间。
  本 PR 不重构跨进程诊断协议，也不增加额外的部署等待门禁。

参考：<https://docs.kernel.org/filesystems/proc.html>、
<https://docs.kernel.org/accounting/psi.html>。

## 验证与上线

新增回归覆盖现场快照、三个实测余量、短时下降、持续压力、恢复滞回、恢复计时重置、
启动低内存、严重低内存、不同主机容量、精确边界、独立 PSI/cgroup 压力、环境自动选择、
生产策略不变和日志。原有 `memoryPressureGuard.test.ts` 保持不变，一并由标准 CI 执行。

该改动位于服务端运行时代码，合并后需要新构建的 Server/Runtime Worker 产物在 Staging
完成部署与验收才生效。仅重跑旧 RC114 会继续使用它绑定的旧产物，不能获得本修复。
CI 成功不是云端部署已恢复；本 PR 不合并、不触发 Staging 或生产发布、不改变历史证据。

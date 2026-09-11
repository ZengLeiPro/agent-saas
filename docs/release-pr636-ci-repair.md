# PR #636 发布可靠性补充修复与验证边界

## 代码依据

原 PR head：`d8f012e0e9f460efe16413d705e3a5daa3b919ca`。
主线基线：`29927a30cdefd34e7919a5a3c90f5eef4070e935`。
本次只向原 PR 增加修复，不合并、不执行生产或测试环境部署。
隔离验证的临时 Workflow 与工作文件不进入本 PR 的文件或提交历史。

## 本次补充

- F03：先验证每个身份字段及 ACS/App/Web 回滚范围，再汇总；未知外部副作用不能被“已恢复旧身份”隐藏；App 回滚必须同时恢复 API 和 Runtime Worker；另一组件出现第三种身份时不建议自动续跑。保留已有严格回执、ConfigIdentity 和人工处置门禁。
- F05：补齐独立 deploymentDrainDeadlineMs 的持久化预期，新增普通维护与部署预算互不覆盖、旧格式加载及无效值拒绝的回归测试。
- F07：多进程验证入口在真实源码进程启动前构建 server 的传递工作区依赖（发布包模式不重建），避免干净 Runner 缺失 ky-app-contract/dist。工具执行改用有界完成屏障：候选 Worker 已启动、旧 Worker 明确记录 SIGUSR2 交棒请求后才允许工具返回，而非假设候选总能在三秒内启动。观察器覆盖先前已收到的 tool_input、失败、断连、超时和监听器清理。
- 历史迁移门禁：对确实变化的 HTTP transport 重新审核，更新 40 条已有 no-schema-change 记录中的该文件 targetDigest；不修改其他路径、基线摘要、分类、审核证据或迁移校验器。

## HTTP transport 重新审核

复核差异为上述主线基线至原 PR head 的 `server/src/runtime/httpTransport.ts`，该文件新的 SHA-256 为 `92fa15d8ec3674f1a09feded49b5008b5218bb641bb8dd40e2b939dc5506a4a6`。

变化仅为默认部署排空等待上限由十分钟改为二十一分钟，以及读取明确未执行的 ACS draining 503 响应中的剩余预算，取本地既有截止时间与远端剩余时间加启动宽限的较小者。重复响应不会延长既有截止时间。只在服务端明确声明 execution-started=false 时保持原请求重试；没有引入新的 SQL、DDL、迁移入口、数据回填或启动建表调用，也没有新增导入依赖。因此，已有 no-schema-change 分类仍成立，但旧源码摘要不能继续复用。

修改记录不是新的数据库迁移批准；实际 RC 和部署仍必须通过独立迁移计划与 postcondition 门禁。历史分类检查允许报告与该历史基线无关的 postcondition 缺失，这不等于允许真实发布缺失 postcondition。

## 验证层级

Node 契约、配置单测、真实 PostgreSQL/两个 Runtime Worker/本地 Hand、确定性模型替身和真实工具副作用计数属于隔离验证。它们不是对真实 ACS Kubernetes/NAS/SNAT、OSS/CDN、已安装 Service Worker、线上用户凭据或在途业务的验收。

原始 F01–F16 的代码与隔离测试在此 PR 中继续接受标准 CI；不得仅凭 Workflow 汇总状态或测试数量声称十八项云端故障注入已经全部完成。尤其需保留真实云端路径的大批量资源/慢请求、旧 PWA 客户端、ACS 在途调用、上传中断、主机重启和共享 Writer 交错升级验收。

F06 的旧 generation 交棒、进程退出、任务最终结清仍是不同事实；F08 的 Staging 不完整状态不意味着全局回滚；F15 的 checkpoint 修复不能重新部署已完成组件。以上边界不能以跳过测试、扩张 ratchet、强杀旧进程或无条件重试来消除。

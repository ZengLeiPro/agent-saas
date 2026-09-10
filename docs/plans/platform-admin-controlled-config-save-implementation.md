# 平台管理配置受控保存实现说明

本实现把 #593 的生产签名发布事务泛化为服务端绑定的操作协议。浏览器只提交 raw revision、当前版本生产确认和 operationId；操作类别、允许字段、路径、环境、签名权威及 API/Worker 目标由路由和服务端决定。

实际 raw diff 必须通过 operation registry；候选基于锁内 fresh raw；生产写入先验证权限、CAS、确认、签名基线和双端旧版本回执，再创建候选 Secret；落盘后由共享刷新器真实消费者完成双端回执。缺消费者不成功。

生图引擎与定价 scope 分离；系统提示语仅改目标合法 ID；工具描述、egress、ACS 运行控制继续使用自己的协议。Codex GET 不写配置，登记改为显式 complete，重授权使用新 ref。正常 token 刷新由服务器内部既有受管 ref 协调签名身份；事务外 Vault 改写仍触发 drift。

本轮不启用全局生产直写，不改变 Workflow，不部署生产，也不操作真实凭据或真实账号。

管理持久 Artifact。使用 action="create" 将工作区内的普通文件注册为不可变 Artifact，成功后返回 artifactId；该动作不会向用户展示文件。使用 action="deliver" 并传 artifact_id，把已创建且属于当前会话的 Artifact 作为持久文件卡交付给用户；交付记录可在刷新和历史回放后恢复，不依赖源文件继续存在。

create 仅接受工作区内普通文件，拒绝符号链接和敏感路径（如 .env、.git/、.ssh/、.npmrc），单文件最大 16 MiB。deliver 不会公开到互联网；公开分享只能由用户在 Artifact 预览页主动操作。不要手写 [FILE] 标记代替 deliver。
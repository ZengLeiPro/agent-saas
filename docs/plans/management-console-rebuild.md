# 管理后台重构执行记录

## 目标

- 左下角头像菜单只保留「设置」「分析」两个入口。
- 设置面包含组织管理 17 项、平台运营 12 项；分析面只注册已有真实数据的组织 4 项、平台 8 项。
- 页面统一为：面包屑 → 页头 → 一层 URL 驱动 Tab → 内容；只有内容壳负责纵向滚动。
- 组织成员只使用治理成员页；旧 `UserManager` 不再被任何菜单可达页面挂载。
- 旧设置 URL 与治理 URL 继续可用，但只落入新导航事实源，不形成第二套入口。

## 旧写接口处置矩阵

| 旧写接口                                 | 原调用点               | 治理替代路径                                      | 处置                                                                           |
| ---------------------------------------- | ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /api/auth/users`                   | `UserManager/hooks.ts` | `POST /api/governance/access/memberships`         | 菜单移除旧成员页；新增成员使用治理 API                                         |
| `PATCH /api/auth/users/:id`（身份/组织） | `UserManager/hooks.ts` | 成员 preview → patch                              | 菜单移除旧成员页；身份和状态使用治理 API                                       |
| `DELETE /api/auth/users/:id`             | `UserManager/hooks.ts` | 离职交接流程                                      | 删除入口退役，改走离职交接                                                     |
| `PATCH /api/auth/users/:id/status`       | `UserManager/hooks.ts` | 成员 preview → patch                              | 成员详情「安全与记录」使用治理状态变更                                         |
| `PATCH /api/agents/:id`、头像上传        | 个人设置「我的智能体」 | 暂无等价治理入口                                  | 保留个人资料能力；不作为组织管理入口                                           |
| 连接器 GitHub/X/阿里云旧写               | 个人设置「连接与授权」 | 凭据 preview/create/status/revoke/rotate/transfer | 组织连接器只挂治理凭据页；个人授权仍限个人作用域                               |
| `/api/org-agents` mutation               | `OrgAgentManager`      | `/api/governance/resources/agents/*`              | 创建、版本、状态、指派均已走治理 API；旧路由仅保留读取、门禁试测和专用媒体上传 |
| Google Workspace / Notion legacy state   | 个人连接页             | 治理凭据或 OAuth grant                            | 不在组织连接器页暴露旧写入口                                                   |

## 不注册的能力

满意度、按部门用量、自动化成功率序列和组织级记忆策略没有完整后端合同，本次不以占位页面冒充已交付能力。

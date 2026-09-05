# @kaiyan/ky-app-cli

`ky-app` 命令行：

| 子命令              | 说明                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`            | 一致性测试 + mock 壳（本地 JWKS、任意 claims 组合签 SAT、iframe 宿主页、菜单树、PG 测试容器与双进程 harness、`/ky/v1/test/*` 驱动） |
| `register`          | 上传仓库 `ky-app.manifest.json` 登记不可变系统版本                                                                                  |
| `onboard`           | 开箱：建组织、赠积分、注册安装、签凭据、导入成员、冒烟                                                                              |
| `rotate-credential` | 服务凭据双凭据重叠轮换                                                                                                              |

`register` / `onboard` / `rotate-credential` 依赖 WP2a 的平台端点：第一期只做参数校验，
随后明确报「依赖 WP2a 平台端点，未实现」并以退出码 2 结束。

**状态：Phase A 只落骨架与 bin 入口（打印用法，退出码 2），实现见 WP1 Phase C。**

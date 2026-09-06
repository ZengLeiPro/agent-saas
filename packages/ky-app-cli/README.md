# @kaiyan/ky-app-cli

`ky-app` 命令行：

| 子命令              | 说明                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`            | 一致性测试 + mock 壳（本地 JWKS、任意 claims 组合签 SAT、iframe 宿主页、菜单树、PG 测试容器与双进程 harness、`/ky/v1/test/*` 驱动） |
| `register`          | 上传仓库 `ky-app.manifest.json` 登记不可变系统版本                                                                                  |
| `onboard`           | 可恢复开箱：建组织、赠积分、注册安装、签凭据、导入成员与租户技能、真实冒烟、交付清单                                                |
| `rotate-credential` | 服务凭据双凭据重叠轮换                                                                                                              |

`register` / `onboard` / `rotate-credential` 通过 `KY_PLATFORM_URL` 和
`KY_PLATFORM_TOKEN` 调用平台端点。Token 只从环境变量读取，不接受命令行参数；
`onboard --resume` 使用平台持久化执行记录恢复，不在本机保存明文凭据或临时进度。

`onboard` 遇到 DNS 验证、凭据领取/确认、ready/digest 或真实诊断尚未就绪时，
会保留 `waiting_external` 状态并给出下一步；条件满足后用同一参数加 `--resume` 继续。

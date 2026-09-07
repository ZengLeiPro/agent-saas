# create-ky-app

开沿定制项目脚手架：生成 Hono（托管静态前端并设响应头）+ Vue 模板项目，
带 `ky-app.manifest.json` / `ky-app.conformance.json` 骨架、声明式权限表、`skills/`、
CI、`.gitignore` + 密钥扫描、`CLAUDE.md` 契约片段。

生成器已可用；`--link` 可直接指向五个本地 tarball 所在目录，适合发布前空目录开箱验收。

```bash
npx create-ky-app my-app --system-id demo-erp --name "演示 ERP" --link ./tarballs
```

`--link` 决定生成项目里 `@kaiyan/*` 依赖的写法：tarball 目录写 `file:`，workspace 绝对路径写 `link:`。

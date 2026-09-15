# Pending workflow for prod Web OSS internal publish

Move into place with a credential that has the `workflow` scope:

```bash
git fetch origin fix/prod-web-oss-internal-publish
git checkout fix/prod-web-oss-internal-publish
cp scripts/release/_pending_workflow/promote-release.yml .github/workflows/promote-release.yml
git add .github/workflows/promote-release.yml
git commit -m "$(cat <<'MSG'
fix(release): 生产 Web 哈希资源改由深圳 ECS 经 OSS 内网发布（workflow）

MSG
)"
git push origin HEAD
# optional cleanup in a follow-up commit:
# rm -rf scripts/release/_pending_workflow && git add -A && git commit -m "chore: drop pending workflow payload" && git push
```

Verify after push:

- Web step calls `publish_immutable_web_assets` / `publish-web-assets-on-ecs.sh`
- Web step does **not** run `upload-web-assets-immutable.sh` on the GitHub runner
- Upload payload includes `publish-web-assets-on-ecs.sh` and related helpers
- Hashed assets hydrate from `artifacts/web-assets.tgz` already pulled via `oss-cn-shenzhen-internal`

Do **not** merge until the workflow file is on the branch (CI asserts the yml contract).

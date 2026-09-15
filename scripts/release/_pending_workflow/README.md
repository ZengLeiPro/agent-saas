# Pending workflow for prod Web OSS internal publish

OAuth tokens without the `workflow` scope cannot push `.github/workflows/promote-release.yml`.
This directory holds the full updated file. Apply it with a workflow-scoped credential:

```bash
gh auth refresh -s workflow
cd /workspace/agent-saas-audit/agent-saas
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

Alternate (same tip as local commit `90de161`, which already contains the yml):

```bash
gh auth refresh -s workflow
git push --force origin 90de1612a49e40d2f13725d6750badc8ca96082e:fix/prod-web-oss-internal-publish
```

Verify after push:

- Web step calls `publish_immutable_web_assets` / `publish-web-assets-on-ecs.sh`
- Web step does **not** run `upload-web-assets-immutable.sh` on the GitHub runner
- Upload payload includes `publish-web-assets-on-ecs.sh` and related helpers
- `web-assets.tgz` is hydrated onto ECS via the production fetch-plan (`oss-cn-shenzhen-internal`)

Do **not** merge until the workflow file is on the branch.

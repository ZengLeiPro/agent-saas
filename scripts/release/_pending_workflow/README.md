# Pending workflow for PR #724

Move into place with a credential that has the `workflow` scope:

```bash
git fetch origin fix/staging-oss-internal-hydrate
git checkout fix/staging-oss-internal-hydrate
cp scripts/release/_pending_workflow/deploy-staging.yml .github/workflows/deploy-staging.yml
git add .github/workflows/deploy-staging.yml
git commit -m "$(cat <<'MSG'
fix(release): Staging 部署改为 ECS 从深圳 OSS 内网 hydrate（workflow）

MSG
)"
git push origin HEAD
# optional cleanup in a follow-up commit:
# rm -rf scripts/release/_pending_workflow && git add -A && git commit -m "chore: drop pending workflow payload" && git push
```

Verify after push: file contains `staging-artifact-fetch-plan.json` and the deploy step no longer scp's `selected/*.tgz`.

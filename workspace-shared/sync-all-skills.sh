#!/usr/bin/env bash
# 手动执行全量 skill 同步（配合 _manifest.json）
set -e

WORKSPACE="${WORKSPACE:-/Users/admin/workspace}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POOL="${POOL:-$SCRIPT_DIR/.ky-agent/skills-pool}"
MANIFEST="$POOL/_manifest.json"

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: Manifest not found at $MANIFEST"
  exit 1
fi

# 用 node 解析 manifest 并为每个用户执行 sync
node -e "
const fs = require('fs');
const path = require('path');
const manifest = JSON.parse(fs.readFileSync('$MANIFEST', 'utf-8'));
const pool = '$POOL';
const workspace = '$WORKSPACE';

// 获取 pool 中的所有 skill
const poolSkills = new Set(
  fs.readdirSync(pool).filter(d => !d.startsWith('_') && !d.startsWith('.') && fs.statSync(path.join(pool, d)).isDirectory())
);

for (const [username, config] of Object.entries(manifest.users)) {
  const userSkills = path.join(workspace, username, '.ky-agent', 'skills');
  if (!fs.existsSync(userSkills)) {
    fs.mkdirSync(userSkills, { recursive: true });
  }

  // 计算目标 skill 集合
  const target = new Set();
  for (const role of config.roles) {
    for (const s of (manifest.roles[role] || [])) target.add(s);
  }

  // 删除多余的系统 skill
  const existing = fs.readdirSync(userSkills).filter(d => {
    try { return fs.statSync(path.join(userSkills, d)).isDirectory(); } catch { return false; }
  });
  for (const d of existing) {
    if (poolSkills.has(d) && !target.has(d)) {
      fs.rmSync(path.join(userSkills, d), { recursive: true, force: true });
      console.log('  removed: ' + d);
    }
  }

  // 复制目标 skill
  for (const skill of target) {
    const src = path.join(pool, skill);
    const dst = path.join(userSkills, skill);
    if (!fs.existsSync(src)) { console.log('  WARN: ' + skill + ' not in pool'); continue; }
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source);
        return name !== '__pycache__' && name !== '.DS_Store' && name !== 'node_modules';
      },
    });
  }
  console.log(username + ': synced ' + target.size + ' skills');
}
"

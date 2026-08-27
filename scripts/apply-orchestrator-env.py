#!/usr/bin/env python3
"""把仓库里声明式的 orchestrator 运行参数 apply 到生产 env 文件。

设计要点（都是为了不出事）：
1. **逐键 upsert，不整文件替换**——生产 env 里有 token 等敏感项与主机相关路径，
   它们不在声明文件里，必须原样保留。整文件覆盖会直接把 orchestrator 打死。
2. **只动声明过的键**：未声明的键一律不碰、不删。声明文件是「我管这些」而非
   「生产应该长这样」。
3. **值按字面写入**，不做 shell 转义/解释——env 文件是 systemd EnvironmentFile
   格式，值里的逗号、斜杠、URL 都按原样保留（历史上用 sed 改这类值踩过坑）。
4. **同步被 runtime JSON 覆盖的声明项**：配额支持管理端热调并持久化，但正式部署时
   仓库声明必须重新成为权威值；只同步明确映射的字段，egress 等运行态配置不动。
5. **打印 diff 并可 --check**：CI 日志留下「谁在什么时候把哪个值从 A 改成 B」，
   这正是手工改 env 最缺的审计。

用法：
    apply-orchestrator-env.py --desired config/production.env --target /etc/agent-saas/acs-orchestrator.env \
      --runtime-config-target /var/lib/agent-saas/acs-orchestrator-runtime.json
    apply-orchestrator-env.py ... --check    # 只报告差异，不写入，有差异时退出码 1
"""
import argparse
import json
import re
import shutil
import sys
from datetime import datetime

KEY_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
# 这些键即使误写进声明文件也拒绝 apply：敏感项与构建产物。
# 宁可让 CI 失败，也不能让一次手滑覆盖掉 token 或把镜像 tag 钉死在仓库里。
FORBIDDEN = {
    'ACS_ORCH_AUTH_TOKEN',
    'ACS_ALERT_WEBHOOK_BEARER_TOKEN',
    'ACS_SANDBOX_IMAGE_PULL_SECRET_NAMES',
    'ACS_SANDBOX_IMAGE',
}
RUNTIME_CONFIG_FIELDS = {
    'ACS_SANDBOX_MAX_RUNNING': 'maxRunningSandboxes',
    'ACS_SANDBOX_WARN_RUNNING': 'warnRunningSandboxes',
    'ACS_SANDBOX_MAX_ALLOCATED_CPU_MILLICORES': 'maxAllocatedCpuMillicores',
    'ACS_SANDBOX_WARN_ALLOCATED_CPU_MILLICORES': 'warnAllocatedCpuMillicores',
    'ACS_SANDBOX_MAX_ALLOCATED_MEMORY_MIB': 'maxAllocatedMemoryMib',
    'ACS_SANDBOX_WARN_ALLOCATED_MEMORY_MIB': 'warnAllocatedMemoryMib',
    'ACS_ORCH_DRAIN_DEADLINE_MS': 'drainDeadlineMs',
}


def parse_env(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        m = KEY_RE.match(stripped)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def desired_runtime_values(desired: dict[str, str]) -> dict[str, int]:
    values: dict[str, int] = {}
    for env_key, runtime_key in RUNTIME_CONFIG_FIELDS.items():
        if env_key not in desired:
            continue
        raw = desired[env_key]
        try:
            value = int(raw, 10)
        except ValueError as exc:
            raise ValueError(f'{env_key} 必须是十进制整数，实际为 {raw!r}') from exc
        if runtime_key == 'drainDeadlineMs':
            if value < 1_000 or value > 24 * 60 * 60_000:
                raise ValueError(f'{env_key} 必须在 1000..86400000 之间')
        elif value < 0 or value > (100_000_000 if 'ALLOCATED' in env_key else 10_000):
            raise ValueError(f'{env_key} 超出允许范围')
        values[runtime_key] = value
    maximum = values.get('maxRunningSandboxes')
    warning = values.get('warnRunningSandboxes')
    if maximum is not None and maximum > 0 and warning is not None and warning > maximum:
        raise ValueError('ACS_SANDBOX_WARN_RUNNING 不得大于 ACS_SANDBOX_MAX_RUNNING')
    for maximum_key, warning_key in (
        ('maxAllocatedCpuMillicores', 'warnAllocatedCpuMillicores'),
        ('maxAllocatedMemoryMib', 'warnAllocatedMemoryMib'),
    ):
        maximum = values.get(maximum_key)
        warning = values.get(warning_key)
        if maximum is not None and maximum > 0 and warning is not None and warning > maximum:
            raise ValueError(f'{warning_key} 不得大于 {maximum_key}')
    return values


def read_runtime_config(path: str) -> dict[str, object]:
    with open(path, encoding='utf-8') as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError('runtime config 必须是 JSON object')
    return raw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--desired', required=True, help='仓库内声明文件')
    ap.add_argument('--target', required=True, help='生产 env 文件')
    ap.add_argument('--runtime-config-target', help='生产 runtime JSON；只同步声明式托管字段')
    ap.add_argument('--check', action='store_true', help='只报告差异，不写入')
    ap.add_argument('--backup-suffix', default=None, help='写入前备份的后缀')
    args = ap.parse_args()

    try:
        with open(args.desired, encoding='utf-8') as f:
            desired_text = f.read()
        with open(args.target, encoding='utf-8') as f:
            target_text = f.read()
    except OSError as exc:
        print(f'读取 env 文件失败: {exc}', file=sys.stderr)
        return 2

    desired = parse_env(desired_text)
    if not desired:
        print('声明文件为空或无合法键，拒绝执行', file=sys.stderr)
        return 2

    illegal = sorted(set(desired) & FORBIDDEN)
    if illegal:
        print(f'声明文件包含禁止托管的键，拒绝执行: {", ".join(illegal)}', file=sys.stderr)
        return 2

    current = parse_env(target_text)
    added = {k: v for k, v in desired.items() if k not in current}
    changed = {k: (current[k], v) for k, v in desired.items() if k in current and current[k] != v}

    runtime_current: dict[str, object] | None = None
    runtime_desired: dict[str, int] = {}
    runtime_changed: dict[str, tuple[object, int]] = {}
    if args.runtime_config_target:
        try:
            runtime_desired = desired_runtime_values(desired)
            runtime_current = read_runtime_config(args.runtime_config_target)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f'读取 runtime config 失败: {exc}', file=sys.stderr)
            return 2
        runtime_changed = {
            key: (runtime_current.get(key), value)
            for key, value in runtime_desired.items()
            if runtime_current.get(key) != value
        }

    if not added and not changed and not runtime_changed:
        print('env 与 runtime config 均已与声明一致，无需变更')
        return 0

    print(f'env 待变更 {len(added) + len(changed)} 项（未声明的键一律不动）：')
    for k, v in sorted(added.items()):
        print(f'  + {k}={v}')
    for k, (old, new) in sorted(changed.items()):
        print(f'  ~ {k}: {old} -> {new}')
    if args.runtime_config_target:
        print(f'runtime config 待变更 {len(runtime_changed)} 项（未映射字段一律不动）：')
        for key, (old, new) in sorted(runtime_changed.items()):
            print(f'  ~ {key}: {old} -> {new}')

    if args.check:
        print('\n--check 模式：未写入')
        return 1

    if args.backup_suffix:
        if added or changed:
            backup = f'{args.target}.bak.{args.backup_suffix}'
            shutil.copy2(args.target, backup)
            print(f'\n已备份到 {backup}')
        if runtime_changed and args.runtime_config_target:
            runtime_backup = f'{args.runtime_config_target}.bak.{args.backup_suffix}'
            shutil.copy2(args.runtime_config_target, runtime_backup)
            print(f'已备份到 {runtime_backup}')

    # 就地改写：命中的行替换，未命中的键追加到文件末尾。
    # 保留原有注释、空行与键序——生产 env 是人读的，不要每次 apply 都重排。
    if added or changed:
        lines = target_text.splitlines()
        seen: set[str] = set()
        for i, line in enumerate(lines):
            m = KEY_RE.match(line.strip())
            if not m:
                continue
            key = m.group(1)
            if key in desired:
                seen.add(key)
                if line.strip() != f'{key}={desired[key]}':
                    lines[i] = f'{key}={desired[key]}'

        missing = [k for k in desired if k not in seen]
        if missing:
            stamp = datetime.now().strftime('%Y-%m-%d')
            lines.append('')
            lines.append(f'# 以下键由 apply-orchestrator-env.py 追加（{stamp}）')
            for k in missing:
                lines.append(f'{k}={desired[k]}')

        with open(args.target, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines).rstrip('\n') + '\n')

    if runtime_changed and args.runtime_config_target and runtime_current is not None:
        runtime_next = {**runtime_current, **runtime_desired}
        with open(args.runtime_config_target, 'w', encoding='utf-8') as f:
            json.dump(runtime_next, f, ensure_ascii=False, indent=2)
            f.write('\n')

    verify = parse_env(open(args.target, encoding='utf-8').read())
    bad = {k: (v, verify.get(k)) for k, v in desired.items() if verify.get(k) != v}
    if bad:
        print(f'写入后校验失败: {bad}', file=sys.stderr)
        return 3
    # 敏感项必须仍在——这是本脚本最重要的一条断言
    lost = [k for k in current if k not in verify]
    if lost:
        print(f'写入后丢失了原有键: {lost}', file=sys.stderr)
        return 3
    if args.runtime_config_target:
        runtime_verify = read_runtime_config(args.runtime_config_target)
        runtime_bad = {
            key: (value, runtime_verify.get(key))
            for key, value in runtime_desired.items()
            if runtime_verify.get(key) != value
        }
        if runtime_bad:
            print(f'runtime config 写入后校验失败: {runtime_bad}', file=sys.stderr)
            return 3
    print('\n写入并校验通过')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

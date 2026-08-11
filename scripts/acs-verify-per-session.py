#!/usr/bin/env python3
"""per-session Sandbox（A 方案）上线验收 + NAS 瓶颈识别。

用法（在能连生产 RDS 的机器上，如深圳 ECS）：
    python3 acs-verify-per-session.py --since '2026-08-11 00:00' [--until '...']

判据来自 `assets/20260809/ACS会话级容器改造-设计与执行交接文档.md` §6.2，
方法与 `assets/20260809/acs-concurrency/analyze.py` 一致（时间加权并发度 + 三桶）。

per-session 上线后语义变了，因此**必须分两个层次**统计：
  - 跨组：不同顶层会话组，各占各 pod → 理论上无争抢，是主指标
  - 组内：父会话 + 其子 Agent，同 pod → 仍共享，属预期

同时输出「独占 P50 趋势」：若并发惩罚下降但独占 P50 反而上升，
说明瓶颈从 CPU 争抢转移到了存储侧（NAS 吞吐），不能误读成改造无效。
"""
import argparse
import os
import subprocess
import sys
from collections import defaultdict
from typing import Optional

# 不落 pod / 容器型工具：计入并发度会重复统计
CONTAINER_TOOLS = {
    'Agent', 'BackgroundTask', 'WaitForWorkspaceReady', 'TodoWrite',
    'AskUserQuestion', 'SessionContext', 'CreateArtifact',
}
# 固定工作量操作，是最干净的信号（命令本身异质性小）
FIXED_COST_TOOLS = ('Read', 'Edit', 'Write')
ACCEPTANCE_TARGET_CROSS_GROUP = 1.2   # 跨组并发2+/独占，靶 <1.2×
ACCEPTANCE_TARGET_IN_GROUP = 1.5      # 组内 typecheck，靶 ≤1.5×
MIN_SOLO_SAMPLES = 5
# 正式验收必须有足够的跨组并发样本；低于 100 只能报方向，不得输出“达标”。
MIN_CONCURRENT_SAMPLES = 100


def query(dsn: str, sql: str) -> list[dict]:
    out = subprocess.run(
        ['psql', dsn, '-At', '-F', '\x1f', '-c', sql],
        capture_output=True, text=True, check=True,
    ).stdout
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        rows.append(line.split('\x1f'))
    return rows


def pct(values, p):
    if not values:
        return None
    vs = sorted(values)
    return vs[max(0, min(len(vs) - 1, int(round((p / 100) * (len(vs) - 1)))))]


def build_sql(since: str, until: Optional[str]) -> str:
    until_clause = f"AND e.timestamp < timestamp with time zone '{until}+08'" if until else ''
    return f"""
    WITH scoped AS (
      SELECT DISTINCT ON (r.session_id)
             r.session_id, r.sandbox_scope_id AS scope
      FROM runtime_runs r
      WHERE r.sandbox_scope_id IS NOT NULL
      ORDER BY r.session_id, r.updated_at DESC
    ),
    st AS (
      SELECT e.session_id, e.timestamp AS ts,
             e.event_json->>'invocationId' AS inv,
             e.event_json->>'toolName' AS tool
      FROM runtime_events e
      WHERE e.event_type = 'tool_invocation_started'
        AND e.timestamp >= timestamp with time zone '{since}+08' {until_clause}
    ),
    cp AS (
      SELECT e.event_json->>'invocationId' AS inv,
             e.timestamp AS ts,
             (e.event_json->>'durationMs')::bigint AS dur
      FROM runtime_events e
      WHERE e.event_type = 'tool_invocation_completed'
        AND e.timestamp >= timestamp with time zone '{since}+08' {until_clause}
        AND e.event_json->>'durationMs' ~ '^[0-9]+$'
    )
    SELECT st.session_id, COALESCE(scoped.scope, 'unknown'), st.tool,
           EXTRACT(EPOCH FROM st.ts), EXTRACT(EPOCH FROM cp.ts), cp.dur
    FROM st JOIN cp ON cp.inv = st.inv
    LEFT JOIN scoped ON scoped.session_id = st.session_id
    """


def acceptance_sample_ready(solo: list[int], concurrent: list[int]) -> bool:
    return len(solo) >= MIN_SOLO_SAMPLES and len(concurrent) >= MIN_CONCURRENT_SAMPLES


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True, help="起始时间，如 '2026-08-11 00:00'")
    ap.add_argument('--until', default=None)
    ap.add_argument('--dsn', default=os.environ.get('ACS_RUNTIME_DSN'),
                    help='PG DSN，默认取环境变量 ACS_RUNTIME_DSN')
    args = ap.parse_args()
    if not args.dsn:
        print('缺少 DSN：用 --dsn 或设置 ACS_RUNTIME_DSN', file=sys.stderr)
        return 2

    # scope 直接取自 runtime_runs.sandbox_scope_id —— per-session 后它就是「会话组」
    # 标识，比从事件里推导父子关系可靠得多。
    sql = build_sql(args.since, args.until)
    rows = query(args.dsn, sql)
    calls = []
    for session, scope, tool, start, end, dur in rows:
        try:
            calls.append({'session': session, 'scope': scope, 'tool': tool,
                          'start': float(start), 'end': float(end), 'dur': int(dur)})
        except (TypeError, ValueError):
            continue
    if not calls:
        print('无样本')
        return 1

    groups = defaultdict(list)
    for c in calls:
        groups[c['scope']].append(c)
    print(f'样本 {len(calls)} 次调用 / {len(groups)} 个会话组 / '
          f'{len({c["session"] for c in calls})} 个会话')

    # ── 跨组并发度：以「会话组」为占用单位 ──
    occupying = [c for c in calls if c['tool'] not in CONTAINER_TOOLS]
    events = []
    for c in occupying:
        events.append((c['start'], c['scope'], 1))
        events.append((c['end'], c['scope'], -1))
    events.sort(key=lambda x: (x[0], -x[2]))
    segments, active, prev = [], defaultdict(int), None
    for t, scope, delta in events:
        if prev is not None and t > prev:
            segments.append((prev, t, frozenset(s for s, n in active.items() if n > 0)))
        active[scope] += delta
        prev = t

    def concurrency(call, key):
        total = call['end'] - call['start']
        if total <= 0:
            return 0.0
        acc = 0.0
        for st, en, act in segments:
            if en <= call['start'] or st >= call['end']:
                continue
            acc += len(act - {call[key]}) * (min(en, call['end']) - max(st, call['start']))
        return acc / total

    for c in calls:
        c['cross'] = concurrency(c, 'scope')
        c['bucket'] = '独占' if c['cross'] < 0.25 else ('并发1' if c['cross'] < 1.25 else '并发2+')

    print('\n══ 主指标：跨组并发惩罚（不同会话组各占各 pod，理论无争抢）══')
    print(f"{'工具':<10}{'独占 n':>8}{'独占 P50':>10}{'并发2+ n':>10}{'并发2+ P50':>12}{'倍数':>9}  判定")
    verdict_all = []
    insufficient_tools = []
    for tool in FIXED_COST_TOOLS:
        solo = [c['dur'] for c in calls if c['tool'] == tool and c['bucket'] == '独占']
        hi = [c['dur'] for c in calls if c['tool'] == tool and c['bucket'] == '并发2+']
        if not acceptance_sample_ready(solo, hi):
            insufficient_tools.append(tool)
            solo_p50 = str(pct(solo, 50)) if solo else '-'
            hi_p50 = str(pct(hi, 50)) if hi else '-'
            detail = f'样本不足（独占≥{MIN_SOLO_SAMPLES}、并发2+≥{MIN_CONCURRENT_SAMPLES}）'
            print(f'{tool:<10}{len(solo):>8}{solo_p50:>10}{len(hi):>10}{hi_p50:>12}{"-":>9}  {detail}')
            continue
        ratio = pct(hi, 50) / pct(solo, 50)
        ok = ratio < ACCEPTANCE_TARGET_CROSS_GROUP
        verdict_all.append(ok)
        print(f'{tool:<10}{len(solo):>8}{pct(solo,50):>10}{len(hi):>10}{pct(hi,50):>12}'
              f'{ratio:>8.2f}×  {"✅ 达标" if ok else "❌ 未达标"}（靶 <{ACCEPTANCE_TARGET_CROSS_GROUP}×）')

    # ── 阴性对照 ──
    print('\n══ 阴性对照（不落 pod，应不随并发变化；否则分桶结论不成立）══')
    for tool in ('TodoWrite',):
        solo = [c['dur'] for c in calls if c['tool'] == tool and c['bucket'] == '独占']
        hi = [c['dur'] for c in calls if c['tool'] == tool and c['bucket'] == '并发2+']
        if len(solo) >= 5 and len(hi) >= 5:
            r = pct(hi, 50) / pct(solo, 50)
            flag = '✅ 正常' if 0.8 <= r <= 1.25 else '⚠️ 异常，分桶可能被时段混杂污染'
            print(f'  {tool}: {pct(solo,50)}ms → {pct(hi,50)}ms = {r:.2f}×  {flag}')
        else:
            print(f'  {tool}: 样本不足')

    # ── NAS 瓶颈信号 ──
    print('\n══ NAS 瓶颈识别（独占态 P50 —— 与并发无关，只反映存储/链路）══')
    print('   若并发惩罚已下降但下列独占 P50 反而升高，说明瓶颈从 CPU 争抢')
    print('   转移到了存储侧，不能误读成「改造无效」。')
    for tool in FIXED_COST_TOOLS:
        solo = [c['dur'] for c in calls if c['tool'] == tool and c['bucket'] == '独占']
        if len(solo) >= 5:
            print(f'  {tool:<8} n={len(solo):<6} P50={pct(solo,50)}ms  P90={pct(solo,90)}ms')
    print('  对照基线（08-10 单 pod 1C2G）：Read/Edit/Write 独占 P50 均 ~880ms')
    print('  其中约 400~600ms 是 sandboxRunner 起进程开销，已由批次 3 预编译消除。')

    # ── 组内 ──
    print('\n══ 组内并发（父会话 + 其子 Agent，同 pod，仍共享属预期）══')
    in_group_hits = 0
    for scope, members in groups.items():
        sessions = {c['session'] for c in members}
        if len(sessions) < 2:
            continue
        in_group_hits += 1
    print(f'  含多会话的组：{in_group_hits} 个'
          + ('（组内 typecheck 靶 ≤%.1f×，需固定命令口径单独测）' % ACCEPTANCE_TARGET_IN_GROUP))

    print('\n══ 结论 ══')
    if not verdict_all:
        print('  样本不足，不下结论。建议跑满一个完整工作日后复测。')
        return 1
    if not all(verdict_all):
        print('  已达样本门槛的主指标存在未达标项 ❌ —— 按分桶数据定位，不要直接回滚')
        return 1
    if insufficient_tools:
        print(f'  已达样本门槛的主指标达标；{", ".join(insufficient_tools)} 样本不足，暂不宣称全量验收通过。')
        return 1
    print('  主指标全部达标 ✅')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

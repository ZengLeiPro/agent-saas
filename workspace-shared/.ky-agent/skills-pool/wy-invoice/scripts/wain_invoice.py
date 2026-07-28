#!/usr/bin/env python3
"""Agent-facing entrypoint for the Wain Schneider invoice skill."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import platform
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


SKILL_DIR = Path(__file__).resolve().parent.parent
RUNTIME_DIR = SKILL_DIR / "runtime"
BEIJING = ZoneInfo("Asia/Shanghai")
REQUIRED_MODULES = ("yaml", "openpyxl", "xlrd", "playwright", "requests")
PUBLIC_TASK_KEYS = (
    "customer",
    "customer_code",
    "statement_no",
    "billing_no",
    "invoice_no",
    "invoice_remark",
    "amount_excl_tax",
    "tax",
    "amount_incl_tax",
    "invoice_date",
    "reconciliation_name",
    "uploaded",
)


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def fail(message: str, *, code: int = 1, **extra) -> int:
    emit({"status": "blocked", "message": message, **extra})
    return code


def missing_modules(required_modules=REQUIRED_MODULES) -> list[str]:
    return [name for name in required_modules if importlib.util.find_spec(name) is None]


def default_output_root() -> Path:
    day = datetime.now(BEIJING).strftime("%Y%m%d")
    return Path.cwd() / "assets" / day / "唯恩施耐德发票"


def configure_runtime(output_root: Path) -> None:
    if str(RUNTIME_DIR) not in sys.path:
        sys.path.insert(0, str(RUNTIME_DIR))
    output_root.mkdir(parents=True, exist_ok=True)
    os.environ["WAIN_INVOICE_RUNS_DIR"] = str(output_root)
    os.environ.setdefault("WAIN_INVOICE_DISABLE_VIDEO", "1")


def configured_urls() -> tuple[str | None, str | None]:
    import yaml

    config_path = RUNTIME_DIR / "clients" / "schneider" / "config.yaml"
    cfg = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    t100 = cfg.get("t100", {})
    return (
        os.environ.get("WAIN_T100_ORDER_URL") or t100.get("order_url"),
        cfg.get("url"),
    )


def probe_url(url: str | None, method: str) -> tuple[bool, str | None]:
    if not url:
        return False, "未配置 URL"
    try:
        request = urllib.request.Request(
            url,
            data=b"" if method == "POST" else None,
            method=method,
            headers={"Accept": "application/json, text/html, */*"},
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            response.read(1)
        return True, None
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def playwright_executable() -> tuple[str | None, str | None]:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            executable = Path(playwright.chromium.executable_path)
        if not executable.exists():
            return str(executable), "Chromium 可执行文件不存在"
        return str(executable), None
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def is_acs_environment() -> bool:
    return platform.system() == "Linux" and Path("/workspace").is_dir()


def doctor(probe_network: bool = False) -> int:
    missing = missing_modules()
    blockers = []
    if missing:
        blockers.append(f"缺少 Python 模块：{', '.join(missing)}")
    browser_path = None
    browser_error = None
    if "playwright" not in missing:
        browser_path, browser_error = playwright_executable()
        if browser_error:
            blockers.append(f"ACS Chromium 不可用：{browser_error}")

    order_url = None
    portal_url = None
    order_reachable = None
    portal_reachable = None
    network_errors = {}
    if "yaml" not in missing:
        order_url, portal_url = configured_urls()
    if probe_network:
        order_reachable, order_error = probe_url(order_url, "POST")
        portal_reachable, portal_error = probe_url(portal_url, "GET")
        if order_error:
            network_errors["t100Order"] = order_error
            blockers.append("ACS 尚不能访问 T100 查询接口")
        if portal_error:
            network_errors["schneiderPortal"] = portal_error
            blockers.append("ACS 尚不能访问施耐德门户")
    else:
        blockers.append("尚未执行网络探测；请运行 doctor --probe-network")

    runtime_ready = not missing and not browser_error
    acs_environment = is_acs_environment()
    if not acs_environment:
        blockers.append("当前不是 Agent SaaS ACS Linux Sandbox；仅完成本地兼容性验证")
    real_submit_ready = (
        runtime_ready
        and acs_environment
        and order_reachable is True
        and portal_reachable is True
    )

    emit(
        {
            "status": "ok",
            "platform": platform.platform(),
            "python": sys.version.split()[0],
            "runtimeExists": (RUNTIME_DIR / "core" / "skill.py").exists(),
            "missingModules": missing,
            "executionEnvironment": (
                "ACS Linux Sandbox"
                if acs_environment
                else f"本地验证（{platform.system()}，非权威执行环境）"
            ),
            "browserBackend": "Playwright Chromium",
            "browserExecutable": browser_path,
            "runtimeReady": runtime_ready,
            "networkProbed": probe_network,
            "t100OrderUrlConfigured": bool(order_url),
            "t100OrderReachable": order_reachable,
            "schneiderPortalReachable": portal_reachable,
            "networkErrors": network_errors,
            "realSubmitReady": real_submit_ready,
            "blockedReason": blockers,
        }
    )
    return 0


def require_dependencies(command: str) -> int | None:
    # 查询清单只依赖 YAML 和标准库，不应因尚未使用的 Excel/浏览器模块阻断。
    required_modules = ("yaml",) if command == "list" else REQUIRED_MODULES
    missing = missing_modules(required_modules)
    if not missing:
        return None
    return fail(
        "技能运行依赖尚未安装。",
        code=10,
        missingModules=missing,
        installCommand=f'python3 -m pip install -r "{SKILL_DIR / "requirements.txt"}"',
    )


async def list_tasks(mode: str) -> int:
    configure_runtime(default_output_root())
    import yaml
    from adapters.t100 import mock as t100_mock
    from adapters.t100 import real as t100_real

    config_path = RUNTIME_DIR / "clients" / "schneider" / "config.yaml"
    cfg = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    adapter = (t100_real if mode == "real" else t100_mock).create(cfg)
    tasks = await adapter.fetch_pending_invoices()
    pending = [
        {key: task.get(key) for key in PUBLIC_TASK_KEYS}
        for task in tasks
        if str(task.get("uploaded") or "").upper() != "Y"
    ]
    emit(
        {
            "status": "ok",
            "mode": mode,
            "count": len(pending),
            "tasks": pending,
            "message": (
                "当前没有待联调数据，请在客户群联系对方补数据。"
                if not pending
                else "请选择精确对账单号后再执行预检。"
            ),
        }
    )
    return 0


async def create_captcha(args: argparse.Namespace) -> int:
    output_root = Path(args.output_root).resolve() if args.output_root else default_output_root()
    configure_runtime(output_root)
    import yaml
    from adapters.t100 import mock as t100_mock
    from adapters.t100 import real as t100_real
    from clients.schneider.flow import prepare_captcha

    config_path = RUNTIME_DIR / "clients" / "schneider" / "config.yaml"
    cfg = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    adapter = (t100_real if args.mode == "real" else t100_mock).create(cfg)
    result = await prepare_captcha(
        cfg,
        adapter,
        args.task_reference,
        output_root,
    )
    emit(result)
    return 0


def require_reference(value: str | None, command: str) -> int | None:
    if value:
        return None
    return fail(
        f"{command} 必须提供 --task-reference，不能在多条待办中默认取第一条。",
        code=11,
    )


def require_captcha(args: argparse.Namespace) -> int | None:
    if not args.captcha or not args.challenge_file:
        return fail(
            "施耐德登录需要人工验证码接力。",
            code=20,
            nextStep=(
                "先执行 captcha 生成验证码图片和 challenge.json；"
                "用户人工读取后，把 --captcha 与 --challenge-file 一起传回。"
            ),
        )
    return None


async def execute(args: argparse.Namespace) -> int:
    output_root = Path(args.output_root).resolve() if args.output_root else default_output_root()
    configure_runtime(output_root)
    from core.skill import run

    command = args.command
    if command in {"preflight", "run", "commit"}:
        blocked = require_reference(args.task_reference, command)
        if blocked is not None:
            return blocked

    if command in {"run", "commit"}:
        blocked = require_captcha(args)
        if blocked is not None:
            return blocked

    commit_reference = None
    if command == "commit":
        values = {
            args.task_reference,
            args.commit_reference,
            args.confirm_submit,
        }
        if None in values or len(values) != 1:
            return fail(
                "最终提交的 task/commit/confirm 三个对账单号必须完整且完全一致。",
                code=12,
            )
        commit_reference = args.commit_reference

    result = await run(
        "schneider",
        args.mode,
        task_reference=args.task_reference,
        commit_reference=commit_reference,
        preflight_only=command == "preflight",
        interactive=False,
        captcha_value=getattr(args, "captcha", None),
        challenge_file=getattr(args, "challenge_file", None),
    )
    if not isinstance(result, dict):
        return fail(
            "流程没有返回可核验的结构化结果，禁止推断成功。",
            code=30,
            command=command,
            taskReference=args.task_reference,
            evidenceRoot=str(output_root),
        )

    outcome = result.get("outcome")
    if outcome == "no_pending_data":
        return fail(
            result.get("message") or "T100 当前没有待联调数据。",
            code=21,
            reason="no_pending_data",
            command=command,
            taskReference=args.task_reference,
            preflightPassed=False,
            excelDownloaded=False,
            websiteReached=False,
            websiteCommitted=False,
            t100WrittenBack=False,
            evidenceRoot=str(output_root),
            evidenceDir=result.get("evidenceDir"),
        )

    expected_outcomes = {
        "preflight": "preflight_passed",
        "run": "confirmation_reached",
        "commit": "website_committed",
    }
    expected = expected_outcomes[command]
    if outcome != expected:
        return fail(
            f"流程结果与命令不一致：command={command}, outcome={outcome!r}。禁止推断成功。",
            code=31,
            command=command,
            taskReference=args.task_reference,
            evidenceRoot=str(output_root),
            result=result,
        )

    excel_path = result.get("excelPath")
    invariants = [
        (bool(result.get("preflightPassed")), "preflightPassed 必须为 true"),
        (bool(result.get("excelDownloaded")), "excelDownloaded 必须为 true"),
        (bool(excel_path) and Path(excel_path).is_file(), "excelPath 必须指向实际文件"),
    ]
    if command == "run":
        invariants.extend(
            [
                (bool(result.get("websiteReached")), "run 必须实际到达最终确认页"),
                (not bool(result.get("websiteCommitted")), "run 不得执行最终确认"),
            ]
        )
    elif command == "commit":
        invariants.extend(
            [
                (bool(result.get("websiteReached")), "commit 必须实际到达最终确认页"),
                (bool(result.get("websiteCommitted")), "commit 必须观察到最终确认成功"),
            ]
        )
    violations = [message for ok, message in invariants if not ok]
    if violations:
        return fail(
            "流程结果缺少成功所需证据，禁止推断成功。",
            code=32,
            command=command,
            taskReference=args.task_reference,
            evidenceRoot=str(output_root),
            violations=violations,
            result=result,
        )

    emit(
        {
            "status": "ok",
            "command": command,
            "outcome": outcome,
            "taskReference": result.get("taskReference") or args.task_reference,
            "preflightPassed": bool(result.get("preflightPassed")),
            "excelDownloaded": bool(result.get("excelDownloaded")),
            "excelPath": result.get("excelPath"),
            "websiteReached": bool(result.get("websiteReached")),
            "websiteCommitted": bool(result.get("websiteCommitted")),
            "t100WrittenBack": bool(result.get("t100WrittenBack")),
            "evidenceRoot": str(output_root),
            "evidenceDir": result.get("evidenceDir"),
            "message": result.get("message"),
        }
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="唯恩施耐德发票技能运行入口")
    subparsers = parser.add_subparsers(dest="command", required=True)
    doctor_parser = subparsers.add_parser(
        "doctor",
        help="检查 ACS 容器是否具备真实运行条件",
    )
    doctor_parser.add_argument(
        "--probe-network",
        action="store_true",
        help="实际探测 T100 查询接口和施耐德门户连通性",
    )

    list_parser = subparsers.add_parser("list", help="查询 T100 待联调发票")
    list_parser.add_argument("--mode", choices=("mock", "real"), default="real")

    captcha_parser = subparsers.add_parser(
        "captcha",
        help="建立施耐德登录会话并生成验证码图片",
    )
    captcha_parser.add_argument("--mode", choices=("mock", "real"), default="real")
    captcha_parser.add_argument("--task-reference", required=True)
    captcha_parser.add_argument("--output-root")

    for name in ("preflight", "run", "commit"):
        child = subparsers.add_parser(name)
        child.add_argument("--mode", choices=("mock", "real"), default="real")
        child.add_argument("--task-reference")
        child.add_argument("--output-root")
        if name in {"run", "commit"}:
            child.add_argument("--captcha")
            child.add_argument("--challenge-file")
        if name == "commit":
            child.add_argument("--commit-reference")
            child.add_argument("--confirm-submit")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "doctor":
        return doctor(args.probe_network)
    dependency_error = require_dependencies(args.command)
    if dependency_error is not None:
        return dependency_error
    if args.command == "list":
        return asyncio.run(list_tasks(args.mode))
    if args.command == "captcha":
        return asyncio.run(create_captcha(args))
    return asyncio.run(execute(args))


if __name__ == "__main__":
    raise SystemExit(main())

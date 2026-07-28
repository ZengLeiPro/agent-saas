from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "wain_invoice.py"
SPEC = importlib.util.spec_from_file_location("wain_invoice_skill", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_default_output_is_workspace_asset_directory(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    output = MODULE.default_output_root()
    assert output.parent.parent == tmp_path / "assets"
    assert output.name == "唯恩施耐德发票"


def test_public_task_never_contains_portal_credentials():
    assert "portal_username" not in MODULE.PUBLIC_TASK_KEYS
    assert "portal_password" not in MODULE.PUBLIC_TASK_KEYS


def test_default_t100_url_uses_customer_public_mapping(monkeypatch):
    monkeypatch.delenv("WAIN_T100_ORDER_URL", raising=False)
    order_url, _ = MODULE.configured_urls()
    assert order_url == (
        "http://guest.wainconnector.com:8888/outesb/xm/"
        "AiService/erp/order/shinaide/list"
    )


def test_list_does_not_require_unused_excel_module(monkeypatch):
    monkeypatch.setattr(
        MODULE,
        "missing_modules",
        lambda required: ["xlrd"] if "xlrd" in required else [],
    )
    assert MODULE.require_dependencies("list") is None


def test_mac_is_not_reported_as_acs(monkeypatch):
    monkeypatch.setattr(MODULE.platform, "system", lambda: "Darwin")
    assert MODULE.is_acs_environment() is False


def test_commit_requires_three_equal_references(monkeypatch, capsys):
    monkeypatch.setattr(MODULE, "require_captcha", lambda _: None)
    args = MODULE.build_parser().parse_args(
        [
            "commit",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
            "--commit-reference",
            "STATEMENT001",
            "--confirm-submit",
            "OTHER",
        ]
    )
    result = MODULE.asyncio.run(MODULE.execute(args))
    assert result == 12
    assert "必须完整且完全一致" in capsys.readouterr().out


def test_run_requires_captcha_and_challenge_file(capsys):
    args = MODULE.build_parser().parse_args(
        [
            "run",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
        ]
    )
    result = MODULE.asyncio.run(MODULE.execute(args))
    assert result == 20
    assert "人工验证码接力" in capsys.readouterr().out


def _install_fake_core_skill(monkeypatch, result):
    core_module = types.ModuleType("core")
    skill_module = types.ModuleType("core.skill")

    async def run(*_, **__):
        return result

    skill_module.run = run
    monkeypatch.setitem(sys.modules, "core", core_module)
    monkeypatch.setitem(sys.modules, "core.skill", skill_module)


def test_preflight_empty_data_is_blocked(monkeypatch, tmp_path, capsys):
    _install_fake_core_skill(
        monkeypatch,
        {
            "outcome": "no_pending_data",
            "message": "当前没有待联调数据。",
            "preflightPassed": False,
            "excelDownloaded": False,
            "websiteReached": False,
            "websiteCommitted": False,
            "t100WrittenBack": False,
            "evidenceDir": str(tmp_path / "run"),
        },
    )
    args = MODULE.build_parser().parse_args(
        [
            "preflight",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
            "--output-root",
            str(tmp_path),
        ]
    )

    result = MODULE.asyncio.run(MODULE.execute(args))

    assert result == 21
    output = capsys.readouterr().out
    assert '"status": "blocked"' in output
    assert '"reason": "no_pending_data"' in output
    assert '"excelDownloaded": false' in output


def test_preflight_requires_explicit_pass_outcome(monkeypatch, tmp_path, capsys):
    _install_fake_core_skill(
        monkeypatch,
        {
            "outcome": "confirmation_reached",
            "preflightPassed": True,
            "excelDownloaded": True,
        },
    )
    args = MODULE.build_parser().parse_args(
        [
            "preflight",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
            "--output-root",
            str(tmp_path),
        ]
    )

    result = MODULE.asyncio.run(MODULE.execute(args))

    assert result == 31
    assert "禁止推断成功" in capsys.readouterr().out


def test_commit_reports_actual_result_not_command_name(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(MODULE, "require_captcha", lambda _: None)
    excel = tmp_path / "match.xlsx"
    excel.write_bytes(b"test")
    _install_fake_core_skill(
        monkeypatch,
        {
            "outcome": "confirmation_reached",
            "preflightPassed": True,
            "excelDownloaded": True,
            "excelPath": str(excel),
            "websiteReached": True,
            "websiteCommitted": False,
            "t100WrittenBack": False,
        },
    )
    args = MODULE.build_parser().parse_args(
        [
            "commit",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
            "--commit-reference",
            "STATEMENT001",
            "--confirm-submit",
            "STATEMENT001",
            "--captcha",
            "1234",
            "--challenge-file",
            str(tmp_path / "challenge.json"),
            "--output-root",
            str(tmp_path),
        ]
    )

    result = MODULE.asyncio.run(MODULE.execute(args))

    assert result == 31
    output = capsys.readouterr().out
    assert "禁止推断成功" in output
    assert '"websiteCommitted": false' in output


def test_preflight_requires_existing_excel_evidence(monkeypatch, tmp_path, capsys):
    _install_fake_core_skill(
        monkeypatch,
        {
            "outcome": "preflight_passed",
            "preflightPassed": True,
            "excelDownloaded": True,
            "excelPath": str(tmp_path / "missing.xlsx"),
            "websiteReached": False,
            "websiteCommitted": False,
            "t100WrittenBack": False,
        },
    )
    args = MODULE.build_parser().parse_args(
        [
            "preflight",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
            "--output-root",
            str(tmp_path),
        ]
    )

    result = MODULE.asyncio.run(MODULE.execute(args))

    assert result == 32
    output = capsys.readouterr().out
    assert "缺少成功所需证据" in output
    assert "excelPath 必须指向实际文件" in output


def test_run_reports_confirmation_reached_from_runtime(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(MODULE, "require_captcha", lambda _: None)
    excel = tmp_path / "match.xlsx"
    excel.write_bytes(b"test")
    _install_fake_core_skill(
        monkeypatch,
        {
            "outcome": "confirmation_reached",
            "message": "已到达最终确认页。",
            "taskReference": "STATEMENT001",
            "preflightPassed": True,
            "excelDownloaded": True,
            "excelPath": str(excel),
            "websiteReached": True,
            "websiteCommitted": False,
            "t100WrittenBack": False,
        },
    )
    args = MODULE.build_parser().parse_args(
        [
            "run",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
            "--captcha",
            "1234",
            "--challenge-file",
            str(tmp_path / "challenge.json"),
            "--output-root",
            str(tmp_path),
        ]
    )

    result = MODULE.asyncio.run(MODULE.execute(args))

    assert result == 0
    output = capsys.readouterr().out
    assert '"outcome": "confirmation_reached"' in output
    assert '"websiteReached": true' in output
    assert '"websiteCommitted": false' in output


def test_commit_reports_verified_runtime_success(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(MODULE, "require_captcha", lambda _: None)
    excel = tmp_path / "match.xlsx"
    excel.write_bytes(b"test")
    _install_fake_core_skill(
        monkeypatch,
        {
            "outcome": "website_committed",
            "message": "最终确认成功。",
            "taskReference": "STATEMENT001",
            "preflightPassed": True,
            "excelDownloaded": True,
            "excelPath": str(excel),
            "websiteReached": True,
            "websiteCommitted": True,
            "t100WrittenBack": False,
        },
    )
    args = MODULE.build_parser().parse_args(
        [
            "commit",
            "--mode",
            "mock",
            "--task-reference",
            "STATEMENT001",
            "--commit-reference",
            "STATEMENT001",
            "--confirm-submit",
            "STATEMENT001",
            "--captcha",
            "1234",
            "--challenge-file",
            str(tmp_path / "challenge.json"),
            "--output-root",
            str(tmp_path),
        ]
    )

    result = MODULE.asyncio.run(MODULE.execute(args))

    assert result == 0
    output = capsys.readouterr().out
    assert '"outcome": "website_committed"' in output
    assert '"websiteReached": true' in output
    assert '"websiteCommitted": true' in output
    assert '"t100WrittenBack": false' in output

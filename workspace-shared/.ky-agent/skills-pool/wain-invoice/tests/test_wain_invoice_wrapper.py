from __future__ import annotations

import importlib.util
import sys
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

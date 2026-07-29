from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import pytest


@pytest.fixture
def cli_module():
    import importlib.util

    script = Path(__file__).parents[2] / "scripts" / "wain_invoice.py"
    spec = importlib.util.spec_from_file_location("wain_invoice_cli", script)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def test_configure_runtime_enables_video_for_prepare(cli_module, monkeypatch, tmp_path):
    monkeypatch.setenv("WAIN_INVOICE_DISABLE_VIDEO", "1")
    cli_module.configure_runtime(tmp_path, record_video=True)
    assert "WAIN_INVOICE_DISABLE_VIDEO" not in cli_module.os.environ


def test_configure_runtime_disables_video_for_other_commands(cli_module, monkeypatch, tmp_path):
    monkeypatch.delenv("WAIN_INVOICE_DISABLE_VIDEO", raising=False)
    cli_module.configure_runtime(tmp_path, record_video=False)
    assert cli_module.os.environ["WAIN_INVOICE_DISABLE_VIDEO"] == "1"


def test_commit_is_blocked_before_runtime(cli_module, monkeypatch, tmp_path, capsys):
    called = False

    def configure_runtime(*_, **__):
        nonlocal called
        called = True

    monkeypatch.setattr(cli_module, "configure_runtime", configure_runtime)
    args = argparse.Namespace(
        command="commit",
        mode="real",
        task_reference="STATEMENT001",
        output_root=str(tmp_path),
    )

    code = asyncio.run(cli_module.execute(args))
    payload = json.loads(capsys.readouterr().out)

    assert called is True
    assert code == 40
    assert payload["reason"] == "ie_mode_required"
    assert payload["websiteCommitted"] is False
    assert payload["t100WrittenBack"] is False

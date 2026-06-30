"""Shared ACS runtime helpers for dws skill scripts."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any
from datetime import datetime
import re

_ORIGINAL_RUN = subprocess.run


def workspace_root() -> Path:
    """Return the current persistent workspace root for dws config storage."""
    return Path(os.environ.get("KY_WORKSPACE_ROOT") or os.environ.get("WORKSPACE_DIR") or os.getcwd()).resolve()


def dws_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Build an environment that keeps dws auth/config inside this workspace."""
    root = workspace_root()
    config_dir = root / ".dws" / "config"
    keychain_dir = root / ".dws" / "keys"
    config_dir.mkdir(parents=True, exist_ok=True)
    keychain_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    if extra:
        env.update(extra)
    env.update(
        {
            "DWS_DISABLE_KEYCHAIN": "1",
            "DWS_CONFIG_DIR": str(config_dir),
            "DWS_KEYCHAIN_DIR": str(keychain_dir),
        }
    )
    return env


def today_ymd() -> str:
    return datetime.now().strftime("%Y%m%d")


def assets_dir(*parts: str) -> Path:
    path = workspace_root() / "assets" / today_ymd()
    for part in parts:
        path = path / part
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_filename(name: str, fallback: str = "dws-output.bin") -> str:
    cleaned = Path(str(name or "")).name
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", cleaned)
    cleaned = re.sub(r"\s+", "_", cleaned).strip("._-")
    return cleaned[:120] or fallback


def _is_dws_command(cmd: Any) -> bool:
    if isinstance(cmd, (list, tuple)) and cmd:
        return Path(str(cmd[0])).name == "dws"
    if isinstance(cmd, str):
        return cmd.strip().split(maxsplit=1)[0] == "dws"
    return False


def patch_subprocess_for_dws() -> None:
    """Inject dws env into subprocess.run calls whose command is dws."""
    if getattr(subprocess.run, "_dws_runtime_patched", False):
        return

    def run(*popenargs: Any, **kwargs: Any) -> subprocess.CompletedProcess:
        cmd = kwargs.get("args") if "args" in kwargs else popenargs[0] if popenargs else None
        if _is_dws_command(cmd):
            kwargs["env"] = dws_env(kwargs.get("env"))
        return _ORIGINAL_RUN(*popenargs, **kwargs)

    setattr(run, "_dws_runtime_patched", True)
    subprocess.run = run

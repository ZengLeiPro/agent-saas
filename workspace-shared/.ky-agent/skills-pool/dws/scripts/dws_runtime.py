"""Workspace convention helpers for user-authored dws skill scripts.

ACS sandbox container already injects DWS_DISABLE_KEYCHAIN /
DWS_CONFIG_DIR / DWS_KEYCHAIN_DIR via Dockerfile ENV in the acs-sandbox
stage, so subprocess env auto-patching is no longer required. This module
therefore only exposes workspace convention helpers (paths, filename
sanitizer, explicit env builder for local-dev fallback) that
user-authored scripts can import when they need them.

Official upstream dws Python scripts under scripts/ do NOT import this
module. Do not add auto-patching of subprocess.run back here — the
container ENV layer is the single source of truth for warm-sandbox
isolation, and monkey-patching from a helper would silently diverge from
that contract.
"""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path


def workspace_root() -> Path:
    """Current persistent workspace root for dws config storage.

    Preference order:
        1. ``$KY_WORKSPACE_ROOT`` (set by agent-saas server on startup)
        2. ``$WORKSPACE_DIR`` (legacy)
        3. Current working directory
    """
    return Path(
        os.environ.get("KY_WORKSPACE_ROOT")
        or os.environ.get("WORKSPACE_DIR")
        or os.getcwd()
    ).resolve()


def dws_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Explicit warm-sandbox env dict for local-dev fallback.

    ACS sandbox already injects these via Dockerfile ENV — use this
    helper only when you need to pass an explicit env to a subprocess
    *outside* the ACS container (e.g. running scripts on a developer
    laptop that hasn't sourced ``.dws/env.sh``).
    """
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
    """Return today's date in YYYYMMDD format (Asia/Shanghai in ACS)."""
    return datetime.now().strftime("%Y%m%d")


def assets_dir(*parts: str) -> Path:
    """Ensure and return ``assets/<yyyymmdd>/<parts...>/`` under the workspace root."""
    path = workspace_root() / "assets" / today_ymd()
    for part in parts:
        path = path / part
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_filename(name: str, fallback: str = "dws-output.bin") -> str:
    """Sanitize a filename: strip path separators, control chars, whitespace."""
    cleaned = Path(str(name or "")).name
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", cleaned)
    cleaned = re.sub(r"\s+", "_", cleaned).strip("._-")
    return cleaned[:120] or fallback

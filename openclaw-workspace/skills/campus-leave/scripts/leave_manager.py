#!/usr/bin/env python3
"""Isolated campus-agent entry point for the shared leave-store implementation."""

from __future__ import annotations

import os
import runpy
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[3]
OPENCLAW_HOME = Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw"))
SHARED_IMPLEMENTATION = (
    OPENCLAW_HOME
    / "workspace"
    / "skills"
    / "campus-leave"
    / "scripts"
    / "leave_manager.py"
)

os.environ.setdefault(
    "CAMPUS_LEAVE_DATA_FILE",
    str(WORKSPACE / "data" / "leave-requests.json"),
)

if not SHARED_IMPLEMENTATION.is_file():
    raise SystemExit("校园请假数据层未安装")

runpy.run_path(str(SHARED_IMPLEMENTATION), run_name="__main__")


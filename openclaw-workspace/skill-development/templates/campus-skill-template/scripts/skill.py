#!/usr/bin/env python3
"""Minimal JSON-stdio implementation for an OpenClaw campus demo Skill."""

from __future__ import annotations

import json
import sys
from typing import Any

INPUT_CONTRACT = "campus-skill-input@1"
OUTPUT_CONTRACT = "campus-skill-output@1"


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")


def result(
    request: dict[str, Any],
    *,
    ok: bool,
    state: str,
    message: str,
    data: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "contract": OUTPUT_CONTRACT,
        "invocationId": str(request.get("invocationId", "unknown")),
        "ok": ok,
        "operation": str(request.get("operation", "unknown")),
        "state": state,
        "message": message,
        "data": data or {},
    }
    if error:
        payload["error"] = error
    return payload


def main() -> int:
    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict) or request.get("contract") != INPUT_CONTRACT:
            raise ValueError("输入信封版本不正确")
        operation = request.get("operation")
        arguments = request.get("arguments") or {}
        topic = str(arguments.get("topic") or "演示任务")[:100]
        if operation == "preview":
            emit(
                result(
                    request,
                    ok=True,
                    state="awaiting-confirmation",
                    message=f"已生成“{topic}”的待确认 Demo 预览。",
                    data={"preview": {"topic": topic, "demo": True}},
                )
            )
            return 0
        if operation == "execute":
            if not bool((request.get("authorization") or {}).get("confirmed")):
                emit(
                    result(
                        request,
                        ok=False,
                        state="failed",
                        message="尚未获得明确确认，因此没有执行写入。",
                        error={
                            "code": "CONFIRMATION_REQUIRED",
                            "message": "写操作需要明确确认",
                            "retryable": True,
                        },
                    )
                )
                return 0
            emit(
                result(
                    request,
                    ok=True,
                    state="completed",
                    message=f"“{topic}”Demo 已执行。",
                    data={"topic": topic, "demo": True},
                )
            )
            return 0
        raise ValueError("未支持的 operation")
    except Exception as error:
        emit(
            {
                "contract": OUTPUT_CONTRACT,
                "invocationId": "unknown",
                "ok": False,
                "operation": "unknown",
                "state": "failed",
                "message": "Skill 输入或执行失败。",
                "data": {},
                "error": {
                    "code": "INVALID_INVOCATION",
                    "message": str(error)[:200],
                    "retryable": False,
                },
            }
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

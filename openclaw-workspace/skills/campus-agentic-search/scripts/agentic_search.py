#!/usr/bin/env python3
"""Contract stub for the server-orchestrated local Agentic Search capability."""

from __future__ import annotations

import json
import sys


def main() -> int:
    request = json.loads(sys.stdin.read() or "{}")
    invocation_id = str(request.get("invocationId") or "unknown")
    print(json.dumps({
        "contract": "campus-skill-output@1",
        "invocationId": invocation_id,
        "ok": True,
        "operation": str(request.get("operation") or "plan-local-search"),
        "state": "completed",
        "message": "本能力由校园 API 执行有界本地检索编排。",
        "data": {"localOnly": True, "maxSearches": 5},
        "cards": []
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Compose trusted course-impact data and a leave preview into one response."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

INPUT_CONTRACT = "campus-skill-input@1"
OUTPUT_CONTRACT = "campus-skill-output@1"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def main() -> int:
    request = json.loads(sys.stdin.read())
    if request.get("contract") != INPUT_CONTRACT:
        raise ValueError("输入契约版本不正确")
    arguments = request.get("arguments") or {}
    target_date = str(arguments.get("targetDate") or "")
    impacts = arguments.get("courseImpacts") or []
    leave = arguments.get("leavePreview") or {}
    missing = [str(item) for item in leave.get("missing", [])][:8]
    reason = str(leave.get("reason") or "").strip()
    reason_summary = re.sub(r"\b\d{6,}\b", "[已隐藏号码]", reason)[:120]
    state = "collecting" if missing else "awaiting-confirmation"
    course_summary = (
        f"发现 {len(impacts)} 门可能受影响的 Demo 课程。"
        if impacts
        else "未发现当天受影响的 Demo 课程。"
    )
    leave_summary = (
        f"请补充：{'、'.join(missing)}。"
        if missing
        else "请假信息已齐全，可以展示完整摘要并等待确认。"
    )
    card = {
        "type": "orchestration-summary",
        "version": 1,
        "id": f"leave-impact:{request['invocationId']}",
        "title": "请假与课程影响 · Demo",
        "targetDate": target_date,
        "leave": {
            "type": str(leave.get("leaveType") or ""),
            "start": str(leave.get("start") or ""),
            "end": str(leave.get("end") or ""),
            "reasonSummary": reason_summary,
        },
        "impacts": impacts,
        "steps": [
            {
                "capabilityId": "campus.course",
                "label": "查询课程影响",
                "status": "completed",
                "summary": course_summary,
            },
            {
                "capabilityId": "campus.leave",
                "label": "生成请假预览",
                "status": "waiting" if missing else "completed",
                "summary": leave_summary,
            },
        ],
        "missing": missing,
        "actions": (
            []
            if missing
            else [
                {
                    "kind": "send-message",
                    "label": "确认提交",
                    "message": "确认提交",
                },
                {
                    "kind": "send-message",
                    "label": "取消",
                    "message": "取消",
                },
            ]
        ),
        "demo": True,
    }
    emit(
        {
            "contract": OUTPUT_CONTRACT,
            "invocationId": request["invocationId"],
            "ok": True,
            "operation": request["operation"],
            "state": state,
            "message": f"{course_summary}{leave_summary} 当前只生成预览，尚未提交请假。",
            "data": {
                "targetDate": target_date,
                "impactCount": len(impacts),
                "missing": missing,
            },
            "cards": [card],
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit(
            {
                "contract": OUTPUT_CONTRACT,
                "invocationId": "unknown",
                "ok": False,
                "operation": "unknown",
                "state": "failed",
                "message": "多 Skill 编排失败，没有提交任何请假。",
                "data": {},
                "error": {
                    "code": "ORCHESTRATION_FAILED",
                    "message": str(error)[:200],
                    "retryable": False,
                },
            }
        )

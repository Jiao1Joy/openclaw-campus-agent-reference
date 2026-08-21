#!/usr/bin/env python3
"""Repeatable, isolated end-to-end demo for the campus assistant engines."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any


DEMO_DIR = Path(__file__).resolve().parent
WORKSPACE = DEMO_DIR.parents[1]
DATA_DIR = WORKSPACE / "data"
ARTIFACT_DIR = DEMO_DIR / "artifacts"
COURSE_SOURCE = DATA_DIR / "course-data.json"
LEAVE_ENGINE = WORKSPACE / "campus-services" / "src" / "bin" / "leaveManagerCli.ts"
LEAVE_INIT = WORKSPACE / "campus-services" / "src" / "bin" / "initDemoDb.ts"
COURSE_ENGINE = WORKSPACE / "skills" / "campus-course" / "scripts" / "course_manager.py"
COMPOSE_ENGINE = WORKSPACE / "skills" / "campus-leave-impact" / "scripts" / "compose.py"
NODE_BIN = os.environ.get("NODE", "node")
STUDENT_ID = "202408621"
CHINA_TZ = timezone(timedelta(hours=8))
DEMO_NOW = "2026-08-11T10:00:00+08:00"
LEAVE_START = "2026-08-12T08:00:00+08:00"
LEAVE_END = "2026-08-12T12:00:00+08:00"
AUDIT_SECRET = "campus-e2e-demo-audit-secret-not-for-production-2026"


class DemoFailure(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_files(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def run_json(
    script: Path,
    arguments: list[str],
    env: dict[str, str],
    stdin_payload: dict[str, Any] | None = None,
    interpreter: str | None = None,
) -> dict[str, Any]:
    command = [interpreter or sys.executable, str(script), *arguments]
    result = subprocess.run(
        command,
        cwd=WORKSPACE,
        env={**os.environ, "PYTHONIOENCODING": "utf-8", **env},
        input=(
            json.dumps(stdin_payload, ensure_ascii=False)
            if stdin_payload is not None
            else None
        ),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise DemoFailure(
            f"{script.name} 未返回 JSON（退出码 {result.returncode}）："
            f"{result.stdout or result.stderr}"
        ) from error
    if result.returncode != 0 or not payload.get("ok", False):
        raise DemoFailure(
            f"{script.name} 执行失败（退出码 {result.returncode}）："
            f"{json.dumps(payload, ensure_ascii=False)}"
        )
    return payload


def find_leave_impacts(
    course_data: dict[str, Any],
    student_id: str,
    start_text: str,
    end_text: str,
) -> list[dict[str, Any]]:
    """Read-only overlap query over the student's existing Demo timetable."""
    start = datetime.fromisoformat(start_text)
    end = datetime.fromisoformat(end_text)
    profile = next(
        item
        for item in course_data["studentProfiles"]
        if item["studentId"] == student_id
    )
    section_index = {item["sectionId"]: item for item in course_data["sections"]}
    teacher_index = {item["id"]: item for item in course_data["teachers"]}
    impacts: list[dict[str, Any]] = []
    cursor: date = start.date()
    while cursor <= end.date():
        for section_id in profile.get("existingSectionIds", []):
            section = section_index[section_id]
            for slot in section.get("schedule", []):
                if int(slot["day"]) != cursor.isoweekday():
                    continue
                slot_start = datetime.combine(
                    cursor, time.fromisoformat(slot["start"]), tzinfo=start.tzinfo
                )
                slot_end = datetime.combine(
                    cursor, time.fromisoformat(slot["end"]), tzinfo=start.tzinfo
                )
                if start < slot_end and end > slot_start:
                    teacher = teacher_index.get(section.get("teacherId"), {})
                    impacts.append(
                        {
                            "sectionId": section_id,
                            "courseName": section["courseName"],
                            "teacher": teacher.get("name", ""),
                            "start": slot_start.isoformat(),
                            "end": slot_end.isoformat(),
                            "location": section.get("location", ""),
                            "demo": True,
                        }
                    )
        cursor += timedelta(days=1)
    return impacts


def audit_summary(path: Path) -> dict[str, Any]:
    events = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return {
        "events": len(events),
        "firstPreviousHash": events[0]["previousHash"] if events else None,
        "lastHash": events[-1]["hash"] if events else None,
        "integrityModes": sorted({item["integrityMode"] for item in events}),
    }


def enrollment_of(course_data: dict[str, Any], section_id: str) -> int:
    section = next(
        item for item in course_data["sections"] if item["sectionId"] == section_id
    )
    return int(section["enrolled"])


def render_markdown(result: dict[str, Any]) -> str:
    leave = result["leaveDemo"]
    course = result["courseDemo"]
    affected = "、".join(item["courseName"] for item in leave["affectedCourses"])
    selected = "、".join(item["courseName"] for item in course["selectedSections"])
    lines = [
        "# 校园助手端到端演示 · 实际运行结果",
        "",
        f"- 运行时间：{result['runAt']}",
        f"- 总体结果：{'通过' if result['ok'] else '失败'}",
        f"- 隔离方式：{result['isolation']}",
        f"- 现有 demo 数据未改动：{str(result['sourceDataUntouched']).lower()}",
        "",
        "## 请假影响、确认、幂等与审计",
        "",
        f"- 待确认预览：`{leave['previewState']}`；命中 {leave['impactCount']} 门课（{affected}）。",
        f"- 预览阶段写入请假：`{str(leave['previewWroteLeave']).lower()}`。",
        f"- 确认后首次提交：`{leave['firstSubmitStatus']}`；首次调用幂等命中：`{str(leave['firstSubmitIdempotent']).lower()}`。",
        f"- 同键重放：`{str(leave['replayIdempotent']).lower()}`；返回同一申请：`{str(leave['sameRequestOnReplay']).lower()}`。",
        f"- 审计校验：`ok={str(leave['auditVerify']['ok']).lower()}`，{leave['auditVerify']['events']} 个事件，问题数 {len(leave['auditVerify']['issues'])}。",
        "",
        "## 选课提交、故障恢复与回滚",
        "",
        f"- 待确认方案：新增 {course['newCredits']} 学分；课程为 {selected}。",
        f"- 确认提交：`{course['submitStatus']}`；提交前复核：`{str(course['finalRevalidationPassed']).lower()}`。",
        f"- 故障注入：临时副本中 `{course['faultInjection']['sectionId']}` 名额从 {course['faultInjection']['before']} 写到 {course['faultInjection']['after']}，同时留下未完成事务日志。",
        f"- 自动恢复：`recovered={str(course['recovery']['recovered']).lower()}`；名额恢复：`{str(course['recoveryRestoredEnrollment']).lower()}`；事务日志已清除：`{str(course['journalCleared']).lower()}`。",
        f"- 运营补偿回滚：`{course['rollbackStatus']}`；同键重放：`{str(course['rollbackReplayIdempotent']).lower()}`。",
        f"- 回滚后临时课程数据恢复基线：`{str(course['sandboxCourseDataRestored']).lower()}`。",
        f"- 审计校验：`ok={str(course['auditVerify']['ok']).lower()}`，{course['auditVerify']['events']} 个事件，问题数 {len(course['auditVerify']['issues'])}。",
        "",
        "## 源数据保护",
        "",
        f"- 运行前文件数：{result['sourceDataCheck']['fileCountBefore']}；运行后文件数：{result['sourceDataCheck']['fileCountAfter']}。",
        f"- 所有源文件 SHA-256 映射一致：`{str(result['sourceDataCheck']['hashesMatch']).lower()}`。",
        "",
    ]
    return "\n".join(lines)


def execute_demo(runtime: Path) -> dict[str, Any]:
    source_before = snapshot_files(DATA_DIR)
    course_baseline = read_json(COURSE_SOURCE)
    course_copy = runtime / "course-data.json"
    course_state = runtime / "course-state.json"
    course_journal = runtime / "course-transaction.json"
    course_audit = runtime / "course-audit.jsonl"
    leave_db = runtime / "leave.sqlite3"
    shutil.copyfile(COURSE_SOURCE, course_copy)
    write_json(course_state, {"plans": [], "submissions": []})

    common_env = {
        "CAMPUS_AUDIT_SECRET": AUDIT_SECRET,
    }
    leave_env = {
        **common_env,
        "CAMPUS_DB_FILE": str(leave_db),
        "CAMPUS_NOW": DEMO_NOW,
        "CAMPUS_REQUEST_ID": "demo-leave-confirmed-001",
        "CAMPUS_IDEMPOTENCY_KEY": "leave-confirmed-demo-0001",
    }
    course_env = {
        **common_env,
        "CAMPUS_COURSE_DATA_FILE": str(course_copy),
        "CAMPUS_COURSE_STATE_FILE": str(course_state),
        "CAMPUS_COURSE_JOURNAL_FILE": str(course_journal),
        "CAMPUS_COURSE_AUDIT_FILE": str(course_audit),
        "CAMPUS_COURSE_NOW": DEMO_NOW,
    }

    print("[1/8] 查询请假时间与现有 Demo 课表的交集")
    impacts = find_leave_impacts(course_baseline, STUDENT_ID, LEAVE_START, LEAVE_END)
    if not impacts:
        raise DemoFailure("演示日期没有命中现有课表")

    run_json(LEAVE_INIT, [], {**leave_env, "CAMPUS_REQUEST_ID": "demo-leave-init-001"}, interpreter=NODE_BIN)

    print("[2/8] 生成只读待确认预览")
    preview = run_json(
        COMPOSE_ENGINE,
        [],
        common_env,
        {
            "contract": "campus-skill-input@1",
            "invocationId": "campus-e2e-leave-preview-001",
            "operation": "compose-preview",
            "arguments": {
                "targetDate": "2026-08-12",
                "courseImpacts": impacts,
                "leavePreview": {
                    "leaveType": "病假",
                    "start": LEAVE_START,
                    "end": LEAVE_END,
                    "reason": "发烧前往校医院就诊",
                    "missing": [],
                },
            },
        },
    )
    preview_state = run_json(
        LEAVE_ENGINE,
        ["list", "--student-id", STUDENT_ID, "--limit", "5"],
        {**leave_env, "CAMPUS_REQUEST_ID": "demo-leave-preview-check-001", "CAMPUS_IDEMPOTENCY_KEY": ""},
        interpreter=NODE_BIN,
    )
    preview_wrote_leave = preview_state["total"] > 0
    if preview["state"] != "awaiting-confirmation" or preview_wrote_leave:
        raise DemoFailure("待确认预览越过了确认边界")

    leave_arguments = [
        "create",
        "--student-id",
        STUDENT_ID,
        "--student-name",
        "林同学",
        "--college",
        "计算机与人工智能学院",
        "--class-name",
        "软件工程 2401 班",
        "--leave-type",
        "病假",
        "--start",
        LEAVE_START,
        "--end",
        LEAVE_END,
        "--reason",
        "发烧前往校医院就诊",
    ]
    print("[3/8] 模拟学生确认，提交请假并用同一幂等键重放")
    leave_created = run_json(LEAVE_ENGINE, leave_arguments, leave_env, interpreter=NODE_BIN)
    leave_replayed = run_json(LEAVE_ENGINE, leave_arguments, leave_env, interpreter=NODE_BIN)
    leave_verified = run_json(LEAVE_ENGINE, ["verify-audit"], leave_env, interpreter=NODE_BIN)
    if not leave_replayed.get("idempotent"):
        raise DemoFailure("请假同键重放没有命中幂等记录")
    if leave_created["request"]["id"] != leave_replayed["request"]["id"]:
        raise DemoFailure("请假重放返回了不同申请")

    print("[4/8] 分析并生成待确认选课方案")
    analyzed = run_json(
        COURSE_ENGINE,
        ["analyze", "--student-id", STUDENT_ID],
        {**course_env, "CAMPUS_REQUEST_ID": "demo-course-analyze-001"},
    )
    if not analyzed.get("requiresTeacherChoice"):
        raise DemoFailure("选课分析没有进入教师选择边界")
    planned = run_json(
        COURSE_ENGINE,
        ["plan", "--student-id", STUDENT_ID, "--choice", "PE201=PE201-02"],
        {
            **course_env,
            "CAMPUS_REQUEST_ID": "demo-course-plan-001",
            "CAMPUS_IDEMPOTENCY_KEY": "course-plan-demo-0001",
        },
    )

    print("[5/8] 模拟学生确认，提交选课并重放")
    submit_arguments = [
        "submit",
        "--student-id",
        STUDENT_ID,
        f"--plan-token={planned['planToken']}",
    ]
    submit_env = {
        **course_env,
        "CAMPUS_REQUEST_ID": "demo-course-submit-001",
        "CAMPUS_IDEMPOTENCY_KEY": "course-submit-demo-0001",
    }
    submitted = run_json(COURSE_ENGINE, submit_arguments, submit_env)
    submit_replayed = run_json(COURSE_ENGINE, submit_arguments, submit_env)
    if not submit_replayed.get("idempotent"):
        raise DemoFailure("选课同键重放没有命中幂等记录")

    print("[6/8] 在临时副本注入跨文件半提交故障并自动恢复")
    fault_section = "CS301-01"
    fault_data = read_json(course_copy)
    fault_before = enrollment_of(fault_data, fault_section)
    for section in fault_data["sections"]:
        if section["sectionId"] == fault_section:
            section["enrolled"] = fault_before + 1
            break
    write_json(course_copy, fault_data)
    write_json(
        course_journal,
        {
            "schemaVersion": 1,
            "transactionId": "TX-DEMO-PARTIAL-001",
            "operation": "course.submit",
            "studentId": STUDENT_ID,
            "resourceId": "CS-DEMO-PARTIAL-001",
            "createdAt": DEMO_NOW,
            "beforeEnrollment": {fault_section: fault_before},
            "afterEnrollment": {fault_section: fault_before + 1},
        },
    )
    recovery = run_json(
        COURSE_ENGINE,
        ["recover"],
        {**course_env, "CAMPUS_REQUEST_ID": "demo-course-recover-001"},
    )
    recovered_enrollment = enrollment_of(read_json(course_copy), fault_section)
    recovery_restored = recovered_enrollment == fault_before
    if not recovery["recovery"]["recovered"] or not recovery_restored:
        raise DemoFailure("事务恢复没有补偿半提交名额")

    print("[7/8] 执行运营补偿回滚并重放")
    submission_id = submitted["submission"]["submissionId"]
    rollback_arguments = [
        "rollback",
        "--student-id",
        STUDENT_ID,
        "--submission-id",
        submission_id,
        "--reason",
        "运营人员确认执行演示补偿回滚",
    ]
    rollback_env = {
        **course_env,
        "CAMPUS_REQUEST_ID": "demo-course-rollback-001",
        "CAMPUS_IDEMPOTENCY_KEY": "course-rollback-demo-0001",
    }
    rolled_back = run_json(COURSE_ENGINE, rollback_arguments, rollback_env)
    rollback_replayed = run_json(COURSE_ENGINE, rollback_arguments, rollback_env)
    course_verified = run_json(COURSE_ENGINE, ["verify-audit"], rollback_env)
    sandbox_restored = read_json(course_copy) == course_baseline
    if not rollback_replayed.get("idempotent") or not sandbox_restored:
        raise DemoFailure("补偿回滚没有恢复临时课程基线")

    print("[8/8] 校验审计链和源 demo 数据指纹")
    source_after = snapshot_files(DATA_DIR)
    source_untouched = source_before == source_after
    if not leave_verified["ok"] or not course_verified["ok"]:
        raise DemoFailure("审计哈希链校验失败")
    if not source_untouched:
        raise DemoFailure("workspace-campus/data 中的源文件发生变化")

    return {
        "ok": True,
        "runAt": datetime.now(CHINA_TZ).isoformat(timespec="seconds"),
        "isolation": "系统临时目录；仅复制 course-data.json，所有业务状态与证据均写入副本",
        "sourceDataUntouched": source_untouched,
        "leaveDemo": {
            "previewState": preview["state"],
            "previewMessage": preview["message"],
            "impactCount": len(impacts),
            "affectedCourses": impacts,
            "previewWroteLeave": preview_wrote_leave,
            "firstSubmitStatus": leave_created["request"]["status"],
            "firstSubmitIdempotent": leave_created["idempotent"],
            "replayIdempotent": leave_replayed["idempotent"],
            "sameRequestOnReplay": (
                leave_created["request"]["id"] == leave_replayed["request"]["id"]
            ),
            "requestId": leave_created["request"]["id"],
            "firstSubmitStatusLabel": leave_created["request"]["statusLabel"],
            "auditVerify": leave_verified,
            "auditChain": {
                "events": leave_verified.get("events", 0),
                "ok": leave_verified.get("ok", False),
            },
        },
        "courseDemo": {
            "requiresTeacherChoice": analyzed["requiresTeacherChoice"],
            "teacherChoice": "PE201=PE201-02",
            "planStatus": planned["status"],
            "newCredits": planned["newCredits"],
            "selectedSections": [
                {
                    "sectionId": item["sectionId"],
                    "courseName": item["courseName"],
                }
                for item in planned["selectedSections"]
            ],
            "submitStatus": submitted["status"],
            "submitReplayIdempotent": submit_replayed["idempotent"],
            "submissionId": submission_id,
            "finalRevalidationPassed": submitted["submission"]["audit"][
                "finalRevalidationPassed"
            ],
            "faultInjection": {
                "sectionId": fault_section,
                "before": fault_before,
                "after": fault_before + 1,
                "transactionId": "TX-DEMO-PARTIAL-001",
            },
            "recovery": recovery["recovery"],
            "recoveryRestoredEnrollment": recovery_restored,
            "journalCleared": not course_journal.exists(),
            "rollbackStatus": rolled_back["status"],
            "rollbackReplayIdempotent": rollback_replayed["idempotent"],
            "sandboxCourseDataRestored": sandbox_restored,
            "auditVerify": course_verified,
            "auditChain": audit_summary(course_audit),
        },
        "sourceDataCheck": {
            "fileCountBefore": len(source_before),
            "fileCountAfter": len(source_after),
            "hashesMatch": source_untouched,
            "courseDataSha256": source_before.get("course-data.json"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="运行隔离的校园助手端到端演示")
    parser.add_argument(
        "--keep-runtime",
        action="store_true",
        help="保留临时运行目录，便于检查完整状态与审计日志",
    )
    args = parser.parse_args()
    runtime = Path(tempfile.mkdtemp(prefix="campus-e2e-demo-"))
    try:
        result = execute_demo(runtime)
        if args.keep_runtime:
            result["runtimeDirectory"] = str(runtime)
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        write_json(ARTIFACT_DIR / "actual-run.json", result)
        (ARTIFACT_DIR / "actual-run.md").write_text(
            render_markdown(result), encoding="utf-8"
        )
        print()
        print("演示通过：预览确认边界、幂等重放、审计校验、故障恢复和补偿回滚均符合预期。")
        print(f"实际结果：{ARTIFACT_DIR / 'actual-run.md'}")
        print(f"结构化证据：{ARTIFACT_DIR / 'actual-run.json'}")
        print("源 demo 数据 SHA-256 前后一致，未发生改动。")
        if args.keep_runtime:
            print(f"临时运行目录已保留：{runtime}")
        return 0
    except Exception as error:
        print(f"演示失败：{error}", file=sys.stderr)
        return 1
    finally:
        if not args.keep_runtime:
            shutil.rmtree(runtime, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

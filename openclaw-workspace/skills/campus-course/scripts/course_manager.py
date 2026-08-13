#!/usr/bin/env python3
"""Deterministic course-selection engine for the local campus demo."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from itertools import combinations
from pathlib import Path
from typing import Any, Iterable


WORKSPACE = Path(__file__).resolve().parents[3]
DATA_FILE = Path(
    os.environ.get("CAMPUS_COURSE_DATA_FILE", WORKSPACE / "data" / "course-data.json")
)
STATE_FILE = Path(
    os.environ.get(
        "CAMPUS_COURSE_STATE_FILE",
        WORKSPACE / "data" / "course-selection-state.json",
    )
)
JOURNAL_FILE = Path(
    os.environ.get(
        "CAMPUS_COURSE_JOURNAL_FILE",
        STATE_FILE.with_name(f"{STATE_FILE.stem}-transaction.json"),
    )
)
AUDIT_FILE = Path(
    os.environ.get(
        "CAMPUS_COURSE_AUDIT_FILE",
        WORKSPACE / "data" / "audit" / "course.jsonl",
    )
)
CHINA_TZ = timezone(timedelta(hours=8))
DAY_NAMES = {1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六", 7: "周日"}
WORKLOAD_SCORE = {"low": 0, "medium": 1, "high": 2}


class CourseError(Exception):
    def __init__(self, code: str, message: str, details: Any | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def output(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def fail(error: CourseError) -> None:
    payload: dict[str, Any] = {
        "ok": False,
        "error": {"code": error.code, "message": error.message},
    }
    if error.details is not None:
        payload["error"]["details"] = error.details
    output(payload)


def load_json(path: Path, default: Any | None = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if default is not None:
            return default
        raise CourseError("DATA_NOT_FOUND", f"找不到数据文件：{path}")
    except json.JSONDecodeError as exc:
        raise CourseError("INVALID_DATA", f"数据文件不是有效 JSON：{path}") from exc


def atomic_write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


@contextmanager
def state_lock() -> Iterable[None]:
    lock_path = STATE_FILE.with_suffix(f"{STATE_FILE.suffix}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as stream:
        stream.seek(0)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def now() -> datetime:
    override = os.environ.get("CAMPUS_COURSE_NOW")
    if override:
        value = datetime.fromisoformat(override)
        return value if value.tzinfo else value.replace(tzinfo=CHINA_TZ)
    return datetime.now(CHINA_TZ)


def iso(value: datetime) -> str:
    return value.astimezone(CHINA_TZ).isoformat(timespec="seconds")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def idempotency_key() -> str:
    value = os.environ.get("CAMPUS_IDEMPOTENCY_KEY", "").strip()
    if value and not all(character.isalnum() or character in "._:-" for character in value):
        raise CourseError("INVALID_IDEMPOTENCY_KEY", "幂等键格式不正确")
    if value and not 8 <= len(value) <= 128:
        raise CourseError("INVALID_IDEMPOTENCY_KEY", "幂等键格式不正确")
    return value


def append_audit(
    action: str,
    outcome: str,
    student_id: str,
    resource_id: str = "",
    **details: Any,
) -> None:
    AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    previous_hash = "0" * 64
    if AUDIT_FILE.exists():
        try:
            lines = [line for line in AUDIT_FILE.read_text(encoding="utf-8").splitlines() if line]
            if lines:
                previous_hash = str(json.loads(lines[-1]).get("hash", previous_hash))
        except (OSError, json.JSONDecodeError) as exc:
            raise CourseError("AUDIT_READ_FAILED", "选课审计证据无法读取") from exc
    unsigned = {
        "schemaVersion": 1,
        "timestamp": iso(now()),
        "requestId": os.environ.get("CAMPUS_REQUEST_ID", "") or secrets.token_hex(16),
        "actorRef": sha256(student_id)[:20],
        "actorIdMasked": f"****{student_id[-4:]}",
        "action": action,
        "outcome": outcome,
        "resourceId": resource_id or None,
        "details": details or None,
        "integrityMode": "hmac-sha256" if os.environ.get("CAMPUS_AUDIT_SECRET") else "demo-sha256",
        "previousHash": previous_hash,
    }
    encoded = canonical_json(unsigned).encode("utf-8")
    secret = os.environ.get("CAMPUS_AUDIT_SECRET", "")
    digest = (
        hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).hexdigest()
        if secret
        else hashlib.sha256(encoded).hexdigest()
    )
    event = {**unsigned, "hash": digest}
    try:
        with AUDIT_FILE.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise CourseError("AUDIT_WRITE_FAILED", "选课审计证据无法写入") from exc


def verify_audit() -> dict[str, Any]:
    if not AUDIT_FILE.exists():
        return {"ok": True, "action": "verify-audit", "events": 0, "issues": []}
    issues: list[dict[str, Any]] = []
    previous_hash = "0" * 64
    secret = os.environ.get("CAMPUS_AUDIT_SECRET", "")
    for line_number, line in enumerate(AUDIT_FILE.read_text(encoding="utf-8").splitlines(), 1):
        if not line:
            continue
        try:
            event = json.loads(line)
            supplied_hash = str(event.pop("hash", ""))
            if event.get("previousHash") != previous_hash:
                issues.append({"line": line_number, "problem": "previousHash 不连续"})
            encoded = canonical_json(event).encode("utf-8")
            mode = event.get("integrityMode")
            if mode == "hmac-sha256" and not secret:
                issues.append({"line": line_number, "problem": "缺少校验该事件所需的 HMAC 密钥"})
                expected = ""
            elif mode == "hmac-sha256":
                expected = hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).hexdigest()
            else:
                expected = hashlib.sha256(encoded).hexdigest()
            if expected and not hmac.compare_digest(supplied_hash, expected):
                issues.append({"line": line_number, "problem": "事件签名不匹配"})
            previous_hash = supplied_hash
        except (json.JSONDecodeError, OSError):
            issues.append({"line": line_number, "problem": "事件不是有效 JSON"})
    return {
        "ok": not issues,
        "action": "verify-audit",
        "events": sum(1 for line in AUDIT_FILE.read_text(encoding="utf-8").splitlines() if line),
        "issues": issues,
    }


def recover_pending_transaction() -> dict[str, Any] | None:
    if not JOURNAL_FILE.exists():
        return None
    journal = load_json(JOURNAL_FILE)
    if not isinstance(journal, dict):
        raise CourseError("RECOVERY_JOURNAL_INVALID", "选课事务恢复日志格式不正确")
    operation = str(journal.get("operation", ""))
    student_id = str(journal.get("studentId", ""))
    resource_id = str(journal.get("resourceId", ""))
    transaction_id = str(journal.get("transactionId", ""))
    before = journal.get("beforeEnrollment") or {}
    after = journal.get("afterEnrollment") or {}
    if operation not in {"course.submit", "course.rollback"} or not student_id:
        raise CourseError("RECOVERY_JOURNAL_INVALID", "选课事务恢复日志缺少必要字段")

    state = load_json(STATE_FILE, {"plans": [], "submissions": []})
    if operation == "course.submit":
        terminal = any(
            item.get("submissionId") == resource_id
            for item in state.get("submissions", [])
        )
    else:
        terminal = any(
            item.get("submissionId") == resource_id
            and item.get("status") == "rolled-back"
            and (item.get("rollback") or {}).get("rollbackId")
            == journal.get("rollbackId")
            for item in state.get("submissions", [])
        )
    if terminal:
        append_audit(
            "course.transaction",
            "reconciled",
            student_id,
            resource_id,
            transactionId=transaction_id,
            operation=operation,
        )
        JOURNAL_FILE.unlink(missing_ok=True)
        return {"recovered": False, "reconciled": True, "transactionId": transaction_id}

    current_data = load_json(DATA_FILE)
    sections, _ = indexes(current_data)
    for section_id, before_value in before.items():
        section = sections.get(str(section_id))
        if not section:
            raise CourseError(
                "RECOVERY_CONFLICT",
                f"恢复事务时找不到教学班 {section_id}",
            )
        current_value = int(section.get("enrolled", 0))
        expected_before = int(before_value)
        expected_after = int(after.get(section_id, expected_before))
        if current_value not in {expected_before, expected_after}:
            raise CourseError(
                "RECOVERY_CONFLICT",
                f"教学班 {section_id} 名额已被其他操作改变，需要人工核对",
            )
        section["enrolled"] = expected_before
    current_data["sections"] = [sections[item["sectionId"]] for item in current_data["sections"]]
    atomic_write(DATA_FILE, current_data)
    append_audit(
        "course.transaction",
        "compensated",
        student_id,
        resource_id,
        transactionId=transaction_id,
        operation=operation,
        restoredEnrollment=before,
    )
    JOURNAL_FILE.unlink(missing_ok=True)
    return {"recovered": True, "reconciled": False, "transactionId": transaction_id}


def recover_before_write() -> dict[str, Any] | None:
    with state_lock():
        return recover_pending_transaction()


def parse_time(value: str) -> int:
    hour, minute = (int(part) for part in value.split(":"))
    return hour * 60 + minute


def week_range(slot: dict[str, Any]) -> tuple[int, int]:
    weeks = slot.get("weeks", [1, 20])
    if not isinstance(weeks, list) or not weeks:
        return (1, 20)
    if len(weeks) == 1:
        return (int(weeks[0]), int(weeks[0]))
    return (int(min(weeks)), int(max(weeks)))


def slots_conflict(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if int(left.get("day", 0)) != int(right.get("day", 0)):
        return False
    left_weeks = week_range(left)
    right_weeks = week_range(right)
    if left_weeks[1] < right_weeks[0] or right_weeks[1] < left_weeks[0]:
        return False
    return parse_time(str(left["start"])) < parse_time(str(right["end"])) and parse_time(
        str(right["start"])
    ) < parse_time(str(left["end"]))


def sections_conflict(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return any(
        slots_conflict(left_slot, right_slot)
        for left_slot in left.get("schedule", [])
        for right_slot in right.get("schedule", [])
    )


def first_conflict(
    section: dict[str, Any], selected: list[dict[str, Any]]
) -> dict[str, Any] | None:
    return next((item for item in selected if sections_conflict(section, item)), None)


def format_schedule(section: dict[str, Any]) -> str:
    parts = []
    for slot in section.get("schedule", []):
        start_week, end_week = week_range(slot)
        parts.append(
            f"{DAY_NAMES.get(int(slot.get('day', 0)), '未知')} "
            f"{slot.get('start')}-{slot.get('end')}（{start_week}-{end_week}周）"
        )
    return "；".join(parts) or "时间待定"


def indexes(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    sections = {item["sectionId"]: item for item in data.get("sections", [])}
    teachers = {item["id"]: item for item in data.get("teachers", [])}
    return sections, teachers


def profile_for(data: dict[str, Any], student_id: str) -> dict[str, Any]:
    profile = next(
        (
            item
            for item in data.get("studentProfiles", [])
            if str(item.get("studentId")) == student_id
        ),
        None,
    )
    if not profile:
        raise CourseError("STUDENT_NOT_FOUND", "未找到当前学生的培养方案数据")
    return profile


def section_view(section: dict[str, Any], teachers: dict[str, Any]) -> dict[str, Any]:
    teacher = teachers.get(section.get("teacherId"), {})
    assessment = section.get("assessment", {})
    return {
        "sectionId": section.get("sectionId"),
        "courseCode": section.get("courseCode"),
        "courseName": section.get("courseName"),
        "credits": section.get("credits"),
        "requirementCategory": section.get("requirementCategory"),
        "teacherId": teacher.get("id"),
        "teacherName": teacher.get("name"),
        "teacherTitle": teacher.get("title"),
        "schedule": format_schedule(section),
        "location": section.get("location"),
        "assessment": assessment.get("label"),
        "examRequired": bool(assessment.get("examRequired")),
        "workload": section.get("workload"),
        "seatsRemaining": max(
            0, int(section.get("capacity", 0)) - int(section.get("enrolled", 0))
        ),
    }


def teacher_option(section: dict[str, Any], teachers: dict[str, Any]) -> dict[str, Any]:
    teacher = teachers.get(section.get("teacherId"), {})
    result = section_view(section, teachers)
    result["teacher"] = {
        "id": teacher.get("id"),
        "name": teacher.get("name"),
        "title": teacher.get("title"),
        "department": teacher.get("department"),
        "education": teacher.get("education"),
        "teachingYears": teacher.get("teachingYears"),
        "researchAreas": teacher.get("researchAreas", []),
        "office": teacher.get("office"),
        "email": teacher.get("email"),
        "profileSummary": teacher.get("profileSummary"),
    }
    return result


def base_context(
    data: dict[str, Any], student_id: str
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    profile = profile_for(data, student_id)
    sections, teachers = indexes(data)
    missing_existing = [
        section_id
        for section_id in profile.get("existingSectionIds", [])
        if section_id not in sections
    ]
    if missing_existing:
        raise CourseError(
            "INVALID_EXISTING_SELECTIONS",
            "已有课表中存在无效教学班",
            missing_existing,
        )
    existing = [sections[item] for item in profile.get("existingSectionIds", [])]
    return profile, sections, teachers, existing


def availability_reason(
    section: dict[str, Any], profile: dict[str, Any], existing: list[dict[str, Any]]
) -> str | None:
    if int(section.get("enrolled", 0)) >= int(section.get("capacity", 0)):
        return "教学班已满"
    completed = set(profile.get("completedCourseCodes", []))
    missing = [item for item in section.get("prerequisites", []) if item not in completed]
    if missing:
        return f"未满足先修课：{', '.join(missing)}"
    conflict = first_conflict(section, existing)
    if conflict:
        return f"与已有课程 {conflict.get('courseName')} 冲突"
    return None


def analyze(data: dict[str, Any], student_id: str) -> dict[str, Any]:
    profile, sections, teachers, existing = base_context(data, student_id)
    required_single: list[dict[str, Any]] = []
    teacher_choices: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []

    for code in profile.get("requiredCourseCodes", []):
        if any(item.get("courseCode") == code for item in existing):
            continue
        candidates = [item for item in sections.values() if item.get("courseCode") == code]
        available = [
            item for item in candidates if availability_reason(item, profile, existing) is None
        ]
        if not available:
            issues.append(
                {
                    "courseCode": code,
                    "type": "required-unavailable",
                    "message": "必修课没有可选教学班，需要联系教务处理，系统不会擅自放弃",
                    "sections": [
                        {
                            **section_view(item, teachers),
                            "unavailableReason": availability_reason(item, profile, existing),
                        }
                        for item in candidates
                    ],
                }
            )
        elif len(available) == 1:
            required_single.append(
                {
                    **section_view(available[0], teachers),
                    "decision": "必修课且只有一个可选教师，纳入待确认方案",
                }
            )
        else:
            teacher_choices.append(
                {
                    "courseCode": code,
                    "courseName": available[0].get("courseName"),
                    "reason": "必修课有多个可选教师，需要学生根据官方教师主页信息自主选择",
                    "options": [teacher_option(item, teachers) for item in available],
                }
            )

    requirements = profile.get("electiveCreditRequirements", {})
    elective_requirements = [
        {"category": category, "creditsRequired": credits}
        for category, credits in requirements.items()
        if float(credits) > 0
    ]
    skipped = []
    for category, credits in requirements.items():
        if float(credits) != 0:
            continue
        for item in sections.values():
            if item.get("nature") == "elective" and item.get("requirementCategory") == category:
                skipped.append(
                    {
                        **section_view(item, teachers),
                        "decision": "该类别没有学分缺口，默认不选",
                    }
                )

    return {
        "ok": not issues,
        "action": "analyze",
        "term": data.get("term"),
        "studentIdMasked": f"****{student_id[-4:]}",
        "existingCredits": sum(float(item.get("credits", 0)) for item in existing),
        "maxCredits": profile.get("maxCredits"),
        "requiredSingleTeacher": required_single,
        "requiredTeacherChoices": teacher_choices,
        "electiveCreditRequirements": elective_requirements,
        "electivePolicy": "先满足学分缺口；同等可行方案优先无考试课程，其次优先低负担课程",
        "defaultSkippedElectives": skipped,
        "issues": issues,
        "requiresTeacherChoice": bool(teacher_choices),
        "requiresFinalConfirmation": True,
    }


def parse_choices(values: list[str]) -> dict[str, str]:
    choices: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise CourseError("INVALID_CHOICE", "教师选择格式应为 课程代码=教学班编号")
        course_code, section_id = (part.strip() for part in value.split("=", 1))
        if not course_code or not section_id:
            raise CourseError("INVALID_CHOICE", "教师选择格式应为 课程代码=教学班编号")
        choices[course_code] = section_id
    return choices


def validate_window(data: dict[str, Any], moment: datetime) -> None:
    window = data.get("selectionWindow", {})
    start = datetime.fromisoformat(str(window.get("start")))
    end = datetime.fromisoformat(str(window.get("end")))
    if not start <= moment <= end:
        raise CourseError(
            "SELECTION_WINDOW_CLOSED",
            "当前不在选课开放时间内",
            {"start": iso(start), "end": iso(end), "current": iso(moment)},
        )


def validate_required_selection(
    required: list[dict[str, Any]], existing: list[dict[str, Any]]
) -> None:
    selected = list(existing)
    for item in required:
        conflict = first_conflict(item, selected)
        if conflict:
            raise CourseError(
                "REQUIRED_COURSE_CONFLICT",
                "必修课程之间存在时间冲突，需要联系教务处理，系统不会擅自舍弃必修课",
                {
                    "left": item.get("sectionId"),
                    "right": conflict.get("sectionId"),
                },
            )
        selected.append(item)


def choose_electives(
    profile: dict[str, Any],
    sections: dict[str, Any],
    fixed: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    requirements = {
        category: float(credits)
        for category, credits in profile.get("electiveCreditRequirements", {}).items()
        if float(credits) > 0
    }
    if not requirements:
        return []

    completed = set(profile.get("completedCourseCodes", []))
    fixed_codes = {item.get("courseCode") for item in fixed}
    candidates = []
    for item in sections.values():
        if item.get("nature") != "elective":
            continue
        if item.get("requirementCategory") not in requirements:
            continue
        if item.get("courseCode") in completed or item.get("courseCode") in fixed_codes:
            continue
        if int(item.get("enrolled", 0)) >= int(item.get("capacity", 0)):
            continue
        if any(code not in completed for code in item.get("prerequisites", [])):
            continue
        if first_conflict(item, fixed):
            continue
        candidates.append(item)

    existing_credits = sum(float(item.get("credits", 0)) for item in fixed)
    max_credits = float(profile.get("maxCredits", 0))
    best: tuple[tuple[Any, ...], list[dict[str, Any]]] | None = None
    for count in range(len(candidates) + 1):
        for subset_tuple in combinations(candidates, count):
            subset = list(subset_tuple)
            if any(
                sections_conflict(left, right)
                for index, left in enumerate(subset)
                for right in subset[index + 1 :]
            ):
                continue
            category_credits = {category: 0.0 for category in requirements}
            for item in subset:
                category_credits[str(item.get("requirementCategory"))] += float(
                    item.get("credits", 0)
                )
            if any(
                category_credits[category] < required
                for category, required in requirements.items()
            ):
                continue
            selected_credits = sum(float(item.get("credits", 0)) for item in subset)
            if existing_credits + selected_credits > max_credits:
                continue
            exam_count = sum(
                1 for item in subset if item.get("assessment", {}).get("examRequired")
            )
            workload = sum(WORKLOAD_SCORE.get(str(item.get("workload")), 3) for item in subset)
            excess = sum(
                category_credits[category] - required
                for category, required in requirements.items()
            )
            score = (
                exam_count,
                workload,
                excess,
                len(subset),
                tuple(sorted(str(item.get("sectionId")) for item in subset)),
            )
            if best is None or score < best[0]:
                best = (score, subset)

    if best is None:
        raise CourseError(
            "NO_FEASIBLE_ELECTIVE_PLAN",
            "在不冲突、满足先修课和学分上限的条件下，无法满足选修学分要求",
            requirements,
        )
    return best[1]


def plan_fingerprint(
    data_version: str, student_id: str, existing_ids: list[str], new_ids: list[str]
) -> str:
    raw = json.dumps(
        {
            "version": data_version,
            "studentId": student_id,
            "existing": sorted(existing_ids),
            "new": sorted(new_ids),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_plan(data: dict[str, Any], student_id: str, choices: dict[str, str]) -> dict[str, Any]:
    validate_window(data, now())
    profile, sections, teachers, existing = base_context(data, student_id)
    required: list[dict[str, Any]] = []
    used_choices: dict[str, str] = {}
    for code in profile.get("requiredCourseCodes", []):
        if any(item.get("courseCode") == code for item in existing):
            continue
        candidates = [
            item
            for item in sections.values()
            if item.get("courseCode") == code
            and availability_reason(item, profile, existing) is None
        ]
        if not candidates:
            raise CourseError(
                "REQUIRED_COURSE_UNAVAILABLE",
                f"必修课 {code} 没有可选教学班，需要联系教务处理",
            )
        if len(candidates) == 1:
            required.append(candidates[0])
            continue
        chosen_id = choices.get(str(code))
        if not chosen_id:
            raise CourseError(
                "TEACHER_CHOICE_REQUIRED",
                f"必修课 {code} 有多个教师，请先由学生自主选择",
                {"courseCode": code, "sectionIds": [item["sectionId"] for item in candidates]},
            )
        chosen = next((item for item in candidates if item.get("sectionId") == chosen_id), None)
        if not chosen:
            raise CourseError(
                "INVALID_TEACHER_CHOICE",
                f"{chosen_id} 不是必修课 {code} 的可用教学班",
            )
        required.append(chosen)
        used_choices[str(code)] = chosen_id

    validate_required_selection(required, existing)
    electives = choose_electives(profile, sections, existing + required)
    selected = required + electives
    all_sections = existing + selected
    for index, left in enumerate(all_sections):
        for right in all_sections[index + 1 :]:
            if sections_conflict(left, right):
                raise CourseError(
                    "TIME_CONFLICT",
                    "生成的方案存在时间冲突，已阻止创建待确认方案",
                    {"left": left.get("sectionId"), "right": right.get("sectionId")},
                )
    total_credits = sum(float(item.get("credits", 0)) for item in all_sections)
    if total_credits > float(profile.get("maxCredits", 0)):
        raise CourseError("MAX_CREDITS_EXCEEDED", "方案超过本学期学分上限")

    created_at = now()
    expires_at = created_at + timedelta(minutes=30)
    plan_id = f"CP-{created_at.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(2).upper()}"
    token = secrets.token_urlsafe(24)
    plan_record = {
        "planId": plan_id,
        "planToken": token,
        "studentId": student_id,
        "term": data.get("term"),
        "dataVersion": data.get("version"),
        "status": "pending-confirmation",
        "createdAt": iso(created_at),
        "expiresAt": iso(expires_at),
        "existingSectionIds": [item["sectionId"] for item in existing],
        "newSectionIds": [item["sectionId"] for item in selected],
        "requiredChoiceSelections": used_choices,
        "fingerprint": plan_fingerprint(
            str(data.get("version")),
            student_id,
            [item["sectionId"] for item in existing],
            [item["sectionId"] for item in selected],
        ),
    }
    with state_lock():
        state = load_json(STATE_FILE, {"plans": [], "submissions": []})
        for old_plan in state.setdefault("plans", []):
            if old_plan.get("studentId") == student_id and old_plan.get("status") == "pending-confirmation":
                old_plan["status"] = "superseded"
                old_plan["supersededAt"] = iso(created_at)
        state["plans"].append(plan_record)
        atomic_write(STATE_FILE, state)

    views = [section_view(item, teachers) for item in selected]
    return {
        "ok": True,
        "action": "plan",
        "planId": plan_id,
        "planToken": token,
        "status": "pending-confirmation",
        "expiresAt": iso(expires_at),
        "existingCredits": sum(float(item.get("credits", 0)) for item in existing),
        "newCredits": sum(float(item.get("credits", 0)) for item in selected),
        "totalCredits": total_credits,
        "selectedSections": views,
        "requiredSelections": [item for item in views if item["requirementCategory"] == "required"],
        "electiveSelections": [item for item in views if item["requirementCategory"] != "required"],
        "policyNotes": [
            "单一教师的必修课已纳入待确认方案",
            "多教师必修课使用了学生自主选择的教学班",
            "有学分缺口的选修课优先无考试，其次优先低负担课程",
            "无学分缺口的选修类别默认未选",
            "已校验时间不冲突、先修课、名额和学分上限",
        ],
        "requiresFinalConfirmation": True,
        "submissionInstruction": "请向学生展示完整方案；只有收到明确确认后，才能使用 planToken 提交",
    }


def revalidate_plan(
    data: dict[str, Any], plan: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    validate_window(data, now())
    student_id = str(plan.get("studentId"))
    profile, sections, _, existing = base_context(data, student_id)
    if plan.get("dataVersion") != data.get("version"):
        raise CourseError("COURSE_DATA_CHANGED", "课程数据版本已变化，请重新生成方案")
    if [item["sectionId"] for item in existing] != plan.get("existingSectionIds"):
        raise CourseError("EXISTING_SCHEDULE_CHANGED", "学生已有课表已变化，请重新生成方案")
    new_ids = plan.get("newSectionIds", [])
    if any(item not in sections for item in new_ids):
        raise CourseError("SECTION_CHANGED", "方案中的教学班已不存在，请重新生成方案")
    selected = [sections[item] for item in new_ids]
    expected_fingerprint = plan_fingerprint(
        str(data.get("version")),
        student_id,
        [item["sectionId"] for item in existing],
        new_ids,
    )
    if not secrets.compare_digest(str(plan.get("fingerprint", "")), expected_fingerprint):
        raise CourseError("PLAN_TAMPERED", "待确认方案校验失败，请重新生成方案")

    completed = set(profile.get("completedCourseCodes", []))
    all_sections = existing + selected
    course_codes = [str(item.get("courseCode")) for item in all_sections]
    if len(course_codes) != len(set(course_codes)):
        raise CourseError("DUPLICATE_COURSE", "方案中存在重复课程")
    for item in selected:
        if int(item.get("enrolled", 0)) >= int(item.get("capacity", 0)):
            raise CourseError(
                "SECTION_FULL",
                f"{item.get('courseName')} 的教学班名额已满，请重新生成方案",
            )
        missing = [code for code in item.get("prerequisites", []) if code not in completed]
        if missing:
            raise CourseError(
                "PREREQUISITE_NOT_MET",
                f"{item.get('courseName')} 的先修课条件已不满足",
                missing,
            )
        if item.get("courseCode") in completed:
            raise CourseError("COURSE_ALREADY_COMPLETED", "方案包含已修课程")
    for index, left in enumerate(all_sections):
        for right in all_sections[index + 1 :]:
            if sections_conflict(left, right):
                raise CourseError(
                    "TIME_CONFLICT",
                    "提交前复核发现时间冲突，请重新生成方案",
                    {"left": left.get("sectionId"), "right": right.get("sectionId")},
                )
    selected_codes = {item.get("courseCode") for item in all_sections}
    missing_required = [
        code for code in profile.get("requiredCourseCodes", []) if code not in selected_codes
    ]
    if missing_required:
        raise CourseError("REQUIRED_COURSE_MISSING", "方案缺少必修课", missing_required)
    requirements = profile.get("electiveCreditRequirements", {})
    for category, required in requirements.items():
        credits = sum(
            float(item.get("credits", 0))
            for item in all_sections
            if item.get("requirementCategory") == category
        )
        if float(required) > 0 and credits < float(required):
            raise CourseError(
                "ELECTIVE_CREDITS_MISSING",
                f"{category} 类别未满足学分要求",
                {"required": required, "selected": credits},
            )
        if float(required) == 0 and any(
            item.get("nature") == "elective" and item.get("requirementCategory") == category
            for item in selected
        ):
            raise CourseError("UNNEEDED_ELECTIVE", "方案包含无学分要求的选修课")
    total_credits = sum(float(item.get("credits", 0)) for item in all_sections)
    if total_credits > float(profile.get("maxCredits", 0)):
        raise CourseError("MAX_CREDITS_EXCEEDED", "方案超过本学期学分上限")
    return profile, existing, selected


def submit_plan(data: dict[str, Any], student_id: str, token: str) -> dict[str, Any]:
    key = idempotency_key()
    key_hash = sha256(key) if key else ""
    with state_lock():
        state = load_json(STATE_FILE, {"plans": [], "submissions": []})
        plan = next(
            (
                item
                for item in state.get("plans", [])
                if item.get("studentId") == student_id
                and secrets.compare_digest(str(item.get("planToken", "")), token)
            ),
            None,
        )
        if not plan:
            raise CourseError("PLAN_NOT_FOUND", "找不到待确认方案，请重新生成")
        keyed_submission = next(
            (
                item
                for item in state.get("submissions", [])
                if item.get("studentId") == student_id
                and key_hash
                and item.get("idempotencyKeyHash") == key_hash
            ),
            None,
        )
        if keyed_submission:
            if keyed_submission.get("planId") != plan.get("planId"):
                raise CourseError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一个幂等键不能提交不同的选课方案",
                )
            current_data = load_json(DATA_FILE)
            sections, teachers = indexes(current_data)
            selected = [
                sections[section_id]
                for section_id in keyed_submission.get("sectionIds", [])
                if section_id in sections
            ]
            append_audit(
                "course.submit",
                "replayed",
                student_id,
                str(keyed_submission.get("submissionId", "")),
                planId=plan.get("planId"),
                idempotencyKeyHash=key_hash,
            )
            return {
                "ok": True,
                "action": "submit",
                "status": "submitted",
                "idempotent": True,
                "submission": keyed_submission,
                "selectedSections": [section_view(item, teachers) for item in selected],
            }
        if plan.get("status") == "submitted":
            submission = next(
                (
                    item
                    for item in state.get("submissions", [])
                    if item.get("planId") == plan.get("planId")
                ),
                None,
            )
            current_data = load_json(DATA_FILE)
            sections, teachers = indexes(current_data)
            selected = [
                sections[section_id]
                for section_id in (submission or {}).get("sectionIds", [])
                if section_id in sections
            ]
            append_audit(
                "course.submit",
                "replayed",
                student_id,
                str((submission or {}).get("submissionId", "")),
                planId=plan.get("planId"),
                idempotencyKeyHash=key_hash or None,
            )
            return {
                "ok": True,
                "action": "submit",
                "status": "submitted",
                "idempotent": True,
                "submission": submission,
                "selectedSections": [section_view(item, teachers) for item in selected],
            }
        if plan.get("status") != "pending-confirmation":
            raise CourseError("PLAN_NOT_PENDING", "该方案已失效，请重新生成")
        expires_at = datetime.fromisoformat(str(plan.get("expiresAt")))
        if now() > expires_at:
            plan["status"] = "expired"
            atomic_write(STATE_FILE, state)
            raise CourseError("PLAN_EXPIRED", "确认方案已过期，请重新生成并复核")

        current_data = load_json(DATA_FILE)
        _, _, selected = revalidate_plan(current_data, plan)
        sections, teachers = indexes(current_data)
        before_enrollment = {
            str(item["sectionId"]): int(item.get("enrolled", 0)) for item in selected
        }
        append_audit(
            "course.submit",
            "attempt",
            student_id,
            str(plan.get("planId", "")),
            planId=plan.get("planId"),
            sectionIds=[item["sectionId"] for item in selected],
            beforeEnrollment=before_enrollment,
            idempotencyKeyHash=key_hash or None,
        )
        for item in selected:
            sections[str(item["sectionId"])]["enrolled"] = int(item.get("enrolled", 0)) + 1
        # Keep the source list ordering while persisting the updated enrollment counts.
        current_data["sections"] = [sections[item["sectionId"]] for item in current_data["sections"]]
        submitted_at = now()
        submission_id = f"CS-{submitted_at.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(2).upper()}"
        submission = {
            "submissionId": submission_id,
            "planId": plan.get("planId"),
            "studentId": student_id,
            "term": current_data.get("term"),
            "sectionIds": [item["sectionId"] for item in selected],
            "submittedAt": iso(submitted_at),
            "status": "submitted",
            "idempotencyKeyHash": key_hash or None,
            "audit": {
                "channel": "campus-web",
                "confirmationRequired": True,
                "finalRevalidationPassed": True,
                "rulesVersion": "campus-course-v1",
            },
        }
        plan["status"] = "submitted"
        plan["submittedAt"] = iso(submitted_at)
        plan["submissionId"] = submission_id
        state.setdefault("submissions", []).append(submission)
        after_enrollment = {
            str(item["sectionId"]): int(item.get("enrolled", 0)) for item in selected
        }
        transaction_id = f"TX-{secrets.token_hex(8).upper()}"
        atomic_write(
            JOURNAL_FILE,
            {
                "schemaVersion": 1,
                "transactionId": transaction_id,
                "operation": "course.submit",
                "studentId": student_id,
                "resourceId": submission_id,
                "createdAt": iso(now()),
                "beforeEnrollment": before_enrollment,
                "afterEnrollment": after_enrollment,
            },
        )
        atomic_write(DATA_FILE, current_data)
        atomic_write(STATE_FILE, state)
        append_audit(
            "course.submit",
            "committed",
            student_id,
            submission_id,
            planId=plan.get("planId"),
            sectionIds=[item["sectionId"] for item in selected],
            beforeEnrollment=before_enrollment,
            afterEnrollment=after_enrollment,
            transactionId=transaction_id,
            idempotencyKeyHash=key_hash or None,
        )
        JOURNAL_FILE.unlink(missing_ok=True)

    return {
        "ok": True,
        "action": "submit",
        "status": "submitted",
        "submission": submission,
        "selectedSections": [section_view(item, teachers) for item in selected],
        "message": "选课已提交，提交前复核已通过",
    }


def rollback_submission(
    data: dict[str, Any],
    student_id: str,
    submission_id: str,
    reason: str,
) -> dict[str, Any]:
    cleaned_reason = " ".join(reason.strip().split())
    if not 4 <= len(cleaned_reason) <= 200:
        raise CourseError("INVALID_ROLLBACK_REASON", "回滚原因需要在 4 到 200 个字符之间")
    key = idempotency_key()
    key_hash = sha256(key) if key else ""
    try:
        window_minutes = int(os.environ.get("CAMPUS_COURSE_ROLLBACK_WINDOW_MINUTES", "30"))
    except ValueError as exc:
        raise CourseError("ROLLBACK_CONFIG_INVALID", "回滚时间窗配置不正确") from exc
    if not 1 <= window_minutes <= 1440:
        raise CourseError("ROLLBACK_CONFIG_INVALID", "回滚时间窗需要在 1 到 1440 分钟之间")

    with state_lock():
        state = load_json(STATE_FILE, {"plans": [], "submissions": []})
        submission = next(
            (
                item
                for item in state.get("submissions", [])
                if item.get("studentId") == student_id
                and item.get("submissionId") == submission_id
            ),
            None,
        )
        if not submission:
            raise CourseError("SUBMISSION_NOT_FOUND", "没有找到这条选课提交记录")
        rollback = submission.get("rollback") or {}
        if submission.get("status") == "rolled-back":
            if key_hash and rollback.get("idempotencyKeyHash") == key_hash:
                append_audit(
                    "course.rollback",
                    "replayed",
                    student_id,
                    submission_id,
                    idempotencyKeyHash=key_hash,
                )
                return {
                    "ok": True,
                    "action": "rollback",
                    "status": "rolled-back",
                    "idempotent": True,
                    "submission": submission,
                }
            raise CourseError("SUBMISSION_ALREADY_ROLLED_BACK", "该选课提交已经回滚")
        if submission.get("status", "submitted") != "submitted":
            raise CourseError("SUBMISSION_NOT_ROLLBACKABLE", "该选课提交当前不能回滚")
        submitted_at = datetime.fromisoformat(str(submission.get("submittedAt")))
        if now() > submitted_at + timedelta(minutes=window_minutes):
            raise CourseError(
                "ROLLBACK_WINDOW_EXPIRED",
                "自动回滚时间窗已过，请转交教务人员处理",
            )

        current_data = load_json(DATA_FILE)
        sections, teachers = indexes(current_data)
        selected = []
        before_enrollment: dict[str, int] = {}
        for section_id in submission.get("sectionIds", []):
            section = sections.get(str(section_id))
            if not section:
                raise CourseError("ROLLBACK_DATA_CHANGED", f"教学班 {section_id} 已不存在")
            enrolled = int(section.get("enrolled", 0))
            if enrolled <= 0:
                raise CourseError("ROLLBACK_DATA_CHANGED", f"教学班 {section_id} 名额数据不一致")
            before_enrollment[str(section_id)] = enrolled
            selected.append(section)

        rollback_id = f"RB-{now().strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(2).upper()}"
        append_audit(
            "course.rollback",
            "attempt",
            student_id,
            submission_id,
            rollbackId=rollback_id,
            sectionIds=list(before_enrollment),
            beforeEnrollment=before_enrollment,
            idempotencyKeyHash=key_hash or None,
        )
        for section in selected:
            section["enrolled"] = int(section.get("enrolled", 0)) - 1
        current_data["sections"] = [sections[item["sectionId"]] for item in current_data["sections"]]
        rolled_back_at = iso(now())
        submission["status"] = "rolled-back"
        submission["rollback"] = {
            "rollbackId": rollback_id,
            "rolledBackAt": rolled_back_at,
            "reason": cleaned_reason,
            "previousStatus": "submitted",
            "idempotencyKeyHash": key_hash or None,
        }
        plan = next(
            (item for item in state.get("plans", []) if item.get("planId") == submission.get("planId")),
            None,
        )
        if plan:
            plan["status"] = "rolled-back"
            plan["rolledBackAt"] = rolled_back_at
        after_enrollment = {
            str(section["sectionId"]): int(section.get("enrolled", 0))
            for section in selected
        }
        transaction_id = f"TX-{secrets.token_hex(8).upper()}"
        atomic_write(
            JOURNAL_FILE,
            {
                "schemaVersion": 1,
                "transactionId": transaction_id,
                "operation": "course.rollback",
                "studentId": student_id,
                "resourceId": submission_id,
                "rollbackId": rollback_id,
                "createdAt": iso(now()),
                "beforeEnrollment": before_enrollment,
                "afterEnrollment": after_enrollment,
            },
        )
        atomic_write(DATA_FILE, current_data)
        atomic_write(STATE_FILE, state)
        append_audit(
            "course.rollback",
            "committed",
            student_id,
            submission_id,
            rollbackId=rollback_id,
            sectionIds=list(before_enrollment),
            beforeEnrollment=before_enrollment,
            afterEnrollment=after_enrollment,
            transactionId=transaction_id,
            idempotencyKeyHash=key_hash or None,
        )
        JOURNAL_FILE.unlink(missing_ok=True)
    return {
        "ok": True,
        "action": "rollback",
        "status": "rolled-back",
        "idempotent": False,
        "submission": submission,
        "selectedSections": [section_view(item, teachers) for item in selected],
    }


def list_plans(student_id: str) -> dict[str, Any]:
    state = load_json(STATE_FILE, {"plans": [], "submissions": []})
    plans = []
    for item in state.get("plans", []):
        if item.get("studentId") != student_id:
            continue
        safe = {key: value for key, value in item.items() if key != "planToken"}
        plans.append(safe)
    submissions = [
        item for item in state.get("submissions", []) if item.get("studentId") == student_id
    ]
    return {
        "ok": True,
        "action": "list",
        "studentIdMasked": f"****{student_id[-4:]}",
        "plans": plans,
        "submissions": submissions,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="云川校园智能选课规则引擎")
    commands = parser.add_subparsers(dest="command", required=True)
    analyze_parser = commands.add_parser("analyze")
    analyze_parser.add_argument("--student-id", required=True)
    plan_parser = commands.add_parser("plan")
    plan_parser.add_argument("--student-id", required=True)
    plan_parser.add_argument("--choice", action="append", default=[])
    submit_parser = commands.add_parser("submit")
    submit_parser.add_argument("--student-id", required=True)
    submit_parser.add_argument("--plan-token", required=True)
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--student-id", required=True)
    rollback_parser.add_argument("--submission-id", required=True)
    rollback_parser.add_argument("--reason", required=True)
    list_parser = commands.add_parser("list")
    list_parser.add_argument("--student-id", required=True)
    commands.add_parser("verify-audit")
    commands.add_parser("recover")
    args = parser.parse_args()

    try:
        if args.command in {"plan", "submit", "rollback"}:
            recover_before_write()
        if args.command == "recover":
            recovery = recover_before_write()
            output(
                {
                    "ok": True,
                    "action": "recover",
                    "recovery": recovery,
                    "message": "没有待恢复事务" if recovery is None else "事务恢复检查已完成",
                }
            )
        data = load_json(DATA_FILE)
        if args.command == "analyze":
            output(analyze(data, args.student_id))
        elif args.command == "plan":
            output(build_plan(data, args.student_id, parse_choices(args.choice)))
        elif args.command == "submit":
            output(submit_plan(data, args.student_id, args.plan_token))
        elif args.command == "rollback":
            output(rollback_submission(data, args.student_id, args.submission_id, args.reason))
        elif args.command == "list":
            output(list_plans(args.student_id))
        elif args.command == "verify-audit":
            output(verify_audit())
        return 0
    except CourseError as error:
        fail(error)
        return 1
    except Exception as error:  # Defensive boundary for the agent tool contract.
        fail(CourseError("INTERNAL_ERROR", "选课引擎处理失败", str(error)))
        return 1


if __name__ == "__main__":
    sys.exit(main())

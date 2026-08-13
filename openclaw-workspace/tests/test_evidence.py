from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[1]
LEAVE_ENGINE = WORKSPACE / "skills" / "campus-leave" / "scripts" / "leave_manager.py"
COURSE_ENGINE = WORKSPACE / "skills" / "campus-course" / "scripts" / "course_manager.py"


def run_json(script: Path, arguments: list[str], env: dict[str, str]) -> dict:
    result = subprocess.run(
        [os.environ.get("PYTHON", "python"), str(script), *arguments],
        cwd=WORKSPACE,
        env={**os.environ, "PYTHONIOENCODING": "utf-8", **env},
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"engine did not return JSON: {result.stdout}\n{result.stderr}") from exc
    payload["_exitCode"] = result.returncode
    return payload


class LeaveEvidenceTests(unittest.TestCase):
    def test_create_and_rollback_are_idempotent_and_audited(self) -> None:
        with tempfile.TemporaryDirectory(prefix="campus-leave-test-") as directory:
            root = Path(directory)
            env = {
                "CAMPUS_LEAVE_DATA_FILE": str(root / "leave.json"),
                "CAMPUS_LEAVE_AUDIT_FILE": str(root / "leave-audit.jsonl"),
                "CAMPUS_REQUEST_ID": "test-request-create",
                "CAMPUS_IDEMPOTENCY_KEY": "leave-create-key-0001",
            }
            arguments = [
                "create",
                "--student-id",
                "202400001",
                "--student-name",
                "林同学",
                "--college",
                "计算机与人工智能学院",
                "--class-name",
                "软件工程 2401 班",
                "--leave-type",
                "病假",
                "--start",
                "2026-08-12T08:00:00+08:00",
                "--end",
                "2026-08-12T12:00:00+08:00",
                "--reason",
                "发烧前往校医院就诊",
            ]
            created = run_json(LEAVE_ENGINE, arguments, env)
            replayed = run_json(LEAVE_ENGINE, arguments, env)
            self.assertTrue(created["ok"])
            self.assertFalse(created["idempotent"])
            self.assertTrue(replayed["idempotent"])
            self.assertEqual(created["request"]["id"], replayed["request"]["id"])

            rollback_env = {
                **env,
                "CAMPUS_REQUEST_ID": "test-request-rollback",
                "CAMPUS_IDEMPOTENCY_KEY": "leave-rollback-key-0001",
                "CAMPUS_AUDIT_SECRET": "test-audit-secret-longer-than-thirty-two-characters",
            }
            rollback_arguments = [
                "cancel",
                "--student-id",
                "202400001",
                "--request-id",
                created["request"]["id"],
                "--reason",
                "学生撤回本次测试申请",
            ]
            rolled_back = run_json(LEAVE_ENGINE, rollback_arguments, rollback_env)
            rollback_replay = run_json(LEAVE_ENGINE, rollback_arguments, rollback_env)
            self.assertEqual(rolled_back["request"]["status"], "cancelled")
            self.assertFalse(rolled_back["idempotent"])
            self.assertTrue(rollback_replay["idempotent"])

            verified = run_json(LEAVE_ENGINE, ["verify-audit"], rollback_env)
            self.assertTrue(verified["ok"])
            self.assertGreaterEqual(verified["events"], 6)


class CourseEvidenceTests(unittest.TestCase):
    def test_submit_and_rollback_are_idempotent_and_audited(self) -> None:
        with tempfile.TemporaryDirectory(prefix="campus-course-test-") as directory:
            root = Path(directory)
            data_file = root / "course-data.json"
            state_file = root / "course-state.json"
            shutil.copyfile(WORKSPACE / "data" / "course-data.json", data_file)
            state_file.write_text('{"plans":[],"submissions":[]}\n', encoding="utf-8")
            base_env = {
                "CAMPUS_COURSE_DATA_FILE": str(data_file),
                "CAMPUS_COURSE_STATE_FILE": str(state_file),
                "CAMPUS_COURSE_AUDIT_FILE": str(root / "course-audit.jsonl"),
                "CAMPUS_COURSE_NOW": "2026-08-11T10:00:00+08:00",
                "CAMPUS_REQUEST_ID": "test-course-plan",
                "CAMPUS_IDEMPOTENCY_KEY": "course-plan-key-0001",
            }
            planned = run_json(
                COURSE_ENGINE,
                [
                    "plan",
                    "--student-id",
                    "202400001",
                    "--choice",
                    "PE201=PE201-02",
                ],
                base_env,
            )
            self.assertTrue(planned["ok"])

            submit_env = {
                **base_env,
                "CAMPUS_REQUEST_ID": "test-course-submit",
                "CAMPUS_IDEMPOTENCY_KEY": "course-submit-key-0001",
            }
            submit_arguments = [
                "submit",
                "--student-id",
                "202400001",
                "--plan-token",
                planned["planToken"],
            ]
            submitted = run_json(COURSE_ENGINE, submit_arguments, submit_env)
            replayed = run_json(COURSE_ENGINE, submit_arguments, submit_env)
            self.assertEqual(submitted["status"], "submitted")
            self.assertTrue(replayed["idempotent"])
            self.assertEqual(
                submitted["submission"]["submissionId"],
                replayed["submission"]["submissionId"],
            )

            rollback_env = {
                **base_env,
                "CAMPUS_REQUEST_ID": "test-course-rollback",
                "CAMPUS_IDEMPOTENCY_KEY": "course-rollback-key-0001",
            }
            rollback_arguments = [
                "rollback",
                "--student-id",
                "202400001",
                "--submission-id",
                submitted["submission"]["submissionId"],
                "--reason",
                "运营人员执行自动化补偿测试",
            ]
            rolled_back = run_json(COURSE_ENGINE, rollback_arguments, rollback_env)
            rollback_replay = run_json(COURSE_ENGINE, rollback_arguments, rollback_env)
            self.assertEqual(rolled_back["status"], "rolled-back")
            self.assertFalse(rolled_back["idempotent"])
            self.assertTrue(rollback_replay["idempotent"])

            verified = run_json(COURSE_ENGINE, ["verify-audit"], rollback_env)
            self.assertTrue(verified["ok"])
            self.assertGreaterEqual(verified["events"], 6)

    def test_recovery_compensates_a_partial_cross_file_transaction(self) -> None:
        with tempfile.TemporaryDirectory(prefix="campus-course-recovery-") as directory:
            root = Path(directory)
            data_file = root / "course-data.json"
            state_file = root / "course-state.json"
            journal_file = root / "course-transaction.json"
            shutil.copyfile(WORKSPACE / "data" / "course-data.json", data_file)
            state_file.write_text('{"plans":[],"submissions":[]}\n', encoding="utf-8")
            data = json.loads(data_file.read_text(encoding="utf-8"))
            section = next(item for item in data["sections"] if item["sectionId"] == "CS301-01")
            before = int(section["enrolled"])
            section["enrolled"] = before + 1
            data_file.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            journal_file.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "transactionId": "TX-PARTIAL-TEST",
                        "operation": "course.submit",
                        "studentId": "202400001",
                        "resourceId": "CS-PARTIAL-TEST",
                        "createdAt": "2026-08-11T10:00:00+08:00",
                        "beforeEnrollment": {"CS301-01": before},
                        "afterEnrollment": {"CS301-01": before + 1},
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            env = {
                "CAMPUS_COURSE_DATA_FILE": str(data_file),
                "CAMPUS_COURSE_STATE_FILE": str(state_file),
                "CAMPUS_COURSE_JOURNAL_FILE": str(journal_file),
                "CAMPUS_COURSE_AUDIT_FILE": str(root / "course-audit.jsonl"),
                "CAMPUS_COURSE_NOW": "2026-08-11T10:00:00+08:00",
                "CAMPUS_REQUEST_ID": "test-course-recovery",
            }
            recovered = run_json(COURSE_ENGINE, ["recover"], env)
            self.assertTrue(recovered["ok"])
            self.assertTrue(recovered["recovery"]["recovered"])
            self.assertFalse(journal_file.exists())
            restored = json.loads(data_file.read_text(encoding="utf-8"))
            restored_section = next(
                item for item in restored["sections"] if item["sectionId"] == "CS301-01"
            )
            self.assertEqual(restored_section["enrolled"], before)
            verified = run_json(COURSE_ENGINE, ["verify-audit"], env)
            self.assertTrue(verified["ok"])


if __name__ == "__main__":
    unittest.main()

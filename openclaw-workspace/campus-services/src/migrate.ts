/**
 * One-shot, re-runnable migration of the legacy `data/leave-requests.json`
 * store into SQLite (plan section 10.3):
 *
 * 1. seed defaults (school, rules) if needed;
 * 2. back up leave-requests.json and data/audit/leave.jsonl with a timestamp;
 * 3. import the legacy audit JSONL as the hash-chain prefix;
 * 4. match or create students by student number (placeholder college);
 * 5. map pending -> manual_review, keep cancelled as cancelled;
 * 6. skip request ids that already exist (idempotent re-runs);
 * 7. report imported / skipped / failed counts.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { GENESIS_HASH, importLegacyEvents, lastHash } from './audit.ts';
import { run, shortId, withTransaction, WORKSPACE_ROOT, type Row } from './db.ts';
import { seedDemoBase } from './seed.ts';

interface LegacyRecord {
  id?: string;
  studentId?: string;
  studentName?: string;
  leaveType?: string;
  start?: string;
  end?: string;
  reason?: string;
  emergencyContact?: { name?: string; phone?: string } | null;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: string;
  evidence?: { idempotencyKeyHash?: string | null };
}

const TYPE_MAP: Record<string, string> = {
  病假: 'sick',
  事假: 'personal',
  公假: 'official',
  其他: 'other',
};

function backupStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function migrateLeaveJson(
  db: DatabaseSync,
  source: string,
  legacyAudit?: string,
): Record<string, unknown> {
  const sourcePath = resolve(source);
  const auditPath = legacyAudit ? resolve(legacyAudit) : join(WORKSPACE_ROOT, 'data', 'audit', 'leave.jsonl');
  if (!existsSync(sourcePath)) {
    return {
      ok: true,
      action: 'migrate-leave-json',
      imported: 0,
      skipped: 0,
      failed: 0,
      message: '未找到待迁移的 leave-requests.json，无需迁移',
    };
  }

  const backupDir = join(WORKSPACE_ROOT, 'data', 'backups', backupStamp());
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(sourcePath, join(backupDir, 'leave-requests.json'));
  const hasLegacyAudit = existsSync(auditPath);
  if (hasLegacyAudit) {
    copyFileSync(auditPath, join(backupDir, 'leave-audit.jsonl'));
  }

  const records = JSON.parse(readFileSync(sourcePath, 'utf8')) as LegacyRecord[];
  if (!Array.isArray(records)) {
    throw new Error('leave-requests.json 必须是数组');
  }

  let imported = 0;
  let skipped = 0;
  let auditImported = false;
  const failures: Array<{ id: string; problem: string }> = [];

  withTransaction(db, () => {
    seedDemoBase(db);
    if (hasLegacyAudit) {
      // idempotent re-runs: only import the prefix into an empty chain
      if (lastHash(db) === GENESIS_HASH) {
        importLegacyEvents(db, readFileSync(auditPath, 'utf8').split(/\r?\n/));
        auditImported = true;
      }
    }

    const stamp = new Date().toISOString();
    const school = db
      .prepare('SELECT id FROM schools ORDER BY created_at LIMIT 1')
      .get() as Row | undefined;
    run(
      db,
      `INSERT OR IGNORE INTO colleges (id, school_id, code, name, status, created_at, updated_at)
       VALUES ('COLLEGE-UNASSIGNED', ?, 'UNASSIGNED', '未分配学院', 'active', ?, ?)`,
      String(school?.id ?? 'SCH-YUNCHUAN'),
      stamp,
      stamp,
    );
    run(
      db,
      `INSERT OR IGNORE INTO classes
         (id, college_id, code, name, grade_year, major_name, status, created_at, updated_at)
       VALUES ('CLASS-UNASSIGNED-0000', 'COLLEGE-UNASSIGNED', 'UNASSIGNED', '未分配班级', 2000, '未分配专业', 'active', ?, ?)`,
      stamp,
      stamp,
    );

    for (const record of records) {
      const id = String(record.id ?? '');
      if (!id) {
        failures.push({ id: '', problem: '缺少申请编号' });
        continue;
      }
      if (db.prepare('SELECT id FROM leave_requests WHERE id = ?').get(id)) {
        skipped += 1;
        continue;
      }
      const studentNo = String(record.studentId ?? '');
      if (!/^[A-Za-z0-9_-]{4,32}$/.test(studentNo)) {
        failures.push({ id, problem: `学号不合法: ${studentNo}` });
        continue;
      }
      const typeCode = TYPE_MAP[String(record.leaveType ?? '')];
      if (!typeCode) {
        failures.push({ id, problem: `假别无法识别: ${record.leaveType}` });
        continue;
      }
      const reason = String(record.reason ?? '');
      if (reason.length < 4 || reason.length > 500) {
        failures.push({ id, problem: '原因长度不合法' });
        continue;
      }
      const createdAt = String(record.createdAt ?? stamp);
      const status =
        record.status === 'cancelled'
          ? 'cancelled'
          : record.status === 'pending' || !record.status
            ? 'manual_review'
            : null;
      if (status === null) {
        failures.push({ id, problem: `旧状态无法映射: ${record.status}` });
        continue;
      }
      let student = db
        .prepare('SELECT id FROM students WHERE student_no = ?')
        .get(studentNo) as Row | undefined;
      if (!student) {
        run(
          db,
          `INSERT INTO students
             (id, student_no, name, college_id, class_id, enrollment_year, status, created_at, updated_at)
           VALUES (?, ?, ?, 'COLLEGE-UNASSIGNED', 'CLASS-UNASSIGNED-0000', 2000, 'active', ?, ?)`,
          studentNo,
          studentNo,
          String(record.studentName ?? `${studentNo.slice(-4)}同学`),
          createdAt,
          createdAt,
        );
        student = db.prepare('SELECT id FROM students WHERE student_no = ?').get(studentNo) as Row;
      }
      try {
        run(
          db,
          `INSERT INTO leave_requests
             (id, student_id, leave_type, start_at, end_at, reason, status, source,
              submitted_at, decided_at, decision_mode, decision_reason, rule_version,
              idempotency_key_hash, emergency_contact_json, row_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1, ?, ?)`,
          id,
          String(student.id ?? studentNo),
          typeCode,
          String(record.start ?? ''),
          String(record.end ?? ''),
          reason,
          status,
          String(record.source ?? 'admin-import'),
          createdAt,
          record.evidence?.idempotencyKeyHash ?? null,
          record.emergencyContact?.name && record.emergencyContact?.phone
            ? JSON.stringify({
                name: record.emergencyContact.name,
                phone: record.emergencyContact.phone,
              })
            : null,
          createdAt,
          String(record.updatedAt ?? createdAt),
        );
        run(
          db,
          `INSERT INTO leave_decisions
             (id, leave_request_id, action, actor_type, actor_ref, actor_name, reason,
              from_status, to_status, request_id, idempotency_key_hash, created_at)
           VALUES (?, ?, 'migrated', 'system', 'migration', 'JSON 迁移脚本', '由 leave-requests.json 迁移',
              'none', ?, NULL, NULL, ?)`,
          shortId('LD'),
          id,
          status,
          createdAt,
        );
        imported += 1;
      } catch (error) {
        failures.push({ id, problem: (error as Error).message });
      }
    }
  });

  return {
    ok: failures.length === 0,
    action: 'migrate-leave-json',
    imported,
    skipped,
    failed: failures.length,
    failures,
    backupDir,
    auditImported,
  };
}

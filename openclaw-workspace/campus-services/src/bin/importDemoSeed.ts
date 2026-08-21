#!/usr/bin/env node
/**
 * Import the generated demo seed (plan section 13) from
 * demo/auto-approval/seed/{school,colleges,classes,students,leave-requests}.json
 * into SQLite.
 *
 * Consistency guarantees:
 * - every leave record is re-evaluated by the real rule engine anchored at
 *   its own submittedAt; records whose declared status contradicts the
 *   computed evidence are REJECTED (the whole import aborts);
 * - foreign keys must resolve; duplicate ids abort the import;
 * - the import is idempotent per leave id and runs in one transaction.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { appendEvent } from '../audit.ts';
import { evaluate, persistEvaluation, seedDefaultRules } from '../approvalEngine.ts';
import { CampusServiceError } from '../errors.ts';
import {
  all,
  get,
  parseDateTime,
  run,
  shortId,
  withTransaction,
  WORKSPACE_ROOT,
  type Row,
} from '../db.ts';

interface SeedLeave {  id?: string;
  studentNo?: string;
  leaveType?: string;
  startAt?: string;
  endAt?: string;
  reason?: string;
  submittedAt?: string;
  status?: string;
  decisionMode?: string | null;
  decidedAt?: string | null;
  decisionReason?: string | null;
  source?: string;
}

/**
 * Write the decision timeline for one imported seed record, mirroring what
 * the live state machine produces: submitted -> (auto-approve | manual-review)
 * -> manual decision / cancellation. Without this, admin detail would show
 * "migrated legacy data" with an empty timeline for human decisions.
 */
function writeSeedDecisions(
  db: Parameters<typeof run>[0],
  leaveRequestId: string,
  info: {
    status: string;
    studentName: string;
    submittedAt: string;
    decidedAt: string | null;
    decisionReason: string | null;
    failedRuleMessage: string;
    evaluationOutcome: 'approved_auto' | 'manual_review';
  },
): void {
  const insert = (
    action: string,
    actorType: string,
    actorRef: string,
    actorName: string | null,
    reason: string | null,
    fromStatus: string,
    toStatus: string,
    createdAt: string,
  ) => {
    run(
      db,
      `INSERT INTO leave_decisions
         (id, leave_request_id, action, actor_type, actor_ref, actor_name, reason,
          from_status, to_status, request_id, idempotency_key_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      shortId('LD'),
      leaveRequestId,
      action,
      actorType,
      actorRef,
      actorName,
      reason,
      fromStatus,
      toStatus,
      createdAt,
    );
  };
  insert('submitted', 'student', `seed:${leaveRequestId}`, info.studentName || null, null, 'none', 'evaluating', info.submittedAt);
  if (info.evaluationOutcome === 'approved_auto') {
    insert(
      'auto-approve',
      'system',
      'rule-engine',
      '自动审批规则引擎',
      info.decisionReason ?? '全部低风险规则通过',
      'evaluating',
      'approved_auto',
      info.decidedAt ?? info.submittedAt,
    );
    return;
  }
  insert(
    'manual-review',
    'system',
    'rule-engine',
    '自动审批规则引擎',
    info.failedRuleMessage,
    'evaluating',
    'manual_review',
    info.submittedAt,
  );
  if (info.status === 'approved_manual') {
    insert('manual-approve', 'admin', 'seed-admin', '校园管理员', info.decisionReason ?? '情况属实，同意请假', 'manual_review', 'approved_manual', info.decidedAt ?? info.submittedAt);
  } else if (info.status === 'rejected_manual') {
    insert('manual-reject', 'admin', 'seed-admin', '校园管理员', info.decisionReason ?? '证明材料不足，请补充后重新申请', 'manual_review', 'rejected_manual', info.decidedAt ?? info.submittedAt);
  } else if (info.status === 'cancelled') {
    insert('cancelled', 'student', `seed:${leaveRequestId}`, null, '学生撤回', 'manual_review', 'cancelled', info.decidedAt ?? info.submittedAt);
  }
}

export function importDemoSeed(
  db: import('node:sqlite').DatabaseSync,
  seedDirInput?: string,
): Record<string, unknown> {
  const seedDir = resolve(WORKSPACE_ROOT, seedDirInput ?? 'demo/auto-approval/seed');
  const readJson = (name: string): unknown => {
    const path = join(seedDir, name);
    if (!existsSync(path)) {
      throw new CampusServiceError('SEED_NOT_FOUND', `种子文件不存在: ${name}`, 404);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  };

  const school = readJson('school.json') as Record<string, unknown>[];
  const colleges = readJson('colleges.json') as Record<string, unknown>[];
  const classes = readJson('classes.json') as Record<string, unknown>[];
  const students = readJson('students.json') as Record<string, unknown>[];
  const leaves = readJson('leave-requests.json') as SeedLeave[];

  const problems: string[] = [];
  const TYPE_MAP: Record<string, string> = {
    sick: 'sick',
    personal: 'personal',
    official: 'official',
    other: 'other',
    病假: 'sick',
    事假: 'personal',
    公假: 'official',
    其他: 'other',
  };
  const FINAL_STATUSES = new Set([
    'approved_auto',
    'approved_manual',
    'rejected_manual',
    'cancelled',
    'manual_review',
  ]);

  const schoolRow = Array.isArray(school) ? school[0] : school;
  if (!schoolRow || !schoolRow.id) {
    throw new CampusServiceError('SEED_INVALID', 'school.json 必须包含一个学校对象');
  }

  let importedLeaves = 0;
  let skippedLeaves = 0;

  withTransaction(db, () => {
    run(
      db,
      `INSERT OR REPLACE INTO schools (id, name, timezone, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      String(schoolRow.id),
      String(schoolRow.name ?? '云川大学'),
      String(schoolRow.timezone ?? 'Asia/Shanghai'),
      String(schoolRow.createdAt ?? new Date().toISOString()),
      String(schoolRow.updatedAt ?? new Date().toISOString()),
    );
    for (const college of colleges) {
      run(
        db,
        `INSERT OR REPLACE INTO colleges
           (id, school_id, code, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        String(college.id ?? ''),
        String(schoolRow.id),
        String(college.code ?? ''),
        String(college.name ?? ''),
        String(college.status ?? 'active'),
        String(college.createdAt ?? new Date().toISOString()),
        String(college.updatedAt ?? new Date().toISOString()),
      );
    }
    for (const klass of classes) {
      run(
        db,
        `INSERT OR REPLACE INTO classes
           (id, college_id, code, name, grade_year, major_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(klass.id ?? ''),
        String(klass.collegeId ?? ''),
        String(klass.code ?? ''),
        String(klass.name ?? ''),
        Number(klass.gradeYear ?? 2000),
        String(klass.majorName ?? ''),
        String(klass.status ?? 'active'),
        String(klass.createdAt ?? new Date().toISOString()),
        String(klass.updatedAt ?? new Date().toISOString()),
      );
    }
    for (const student of students) {
      run(
        db,
        `INSERT OR REPLACE INTO students
           (id, student_no, name, college_id, class_id, enrollment_year, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(student.studentNo ?? student.id ?? ''),
        String(student.studentNo ?? student.id ?? ''),
        String(student.name ?? ''),
        String(student.collegeId ?? ''),
        String(student.classId ?? ''),
        Number(student.enrollmentYear ?? 2024),
        String(student.status ?? 'active'),
        String(student.createdAt ?? new Date().toISOString()),
        String(student.updatedAt ?? new Date().toISOString()),
      );
    }
    seedDefaultRules(db, 'seed');

    const seenIds = new Set<string>();
    for (const leave of leaves) {
      const id = String(leave.id ?? '');
      if (!id || seenIds.has(id)) {
        problems.push(`缺少编号或编号重复: ${id}`);
        continue;
      }
      seenIds.add(id);
      if (get(db, 'SELECT id FROM leave_requests WHERE id = ?', id)) {
        skippedLeaves += 1;
        continue;
      }
      const studentRow = get(
        db,
        'SELECT * FROM students WHERE student_no = ?',
        String(leave.studentNo ?? ''),
      ) as Row | undefined;
      if (!studentRow) {
        problems.push(`${id}: 学生不存在 ${leave.studentNo}`);
        continue;
      }
      const typeCode = TYPE_MAP[String(leave.leaveType ?? '')];
      const status = String(leave.status ?? '');
      if (!typeCode || !FINAL_STATUSES.has(status)) {
        problems.push(`${id}: 假别或状态不合法`);
        continue;
      }
      const submittedIso = String(leave.submittedAt ?? '');
      const startIso = String(leave.startAt ?? '');
      const endIso = String(leave.endAt ?? '');
      try {
        parseDateTime(submittedIso, '提交时间');
        parseDateTime(startIso, '开始时间');
        parseDateTime(endIso, '结束时间');
      } catch (error) {
        problems.push(`${id}: ${(error as Error).message}`);
        continue;
      }

      // Re-run the real engine anchored at submittedAt; declared auto-approved
      // records must match the computed outcome exactly (plan 13.2).
      const evaluation = evaluate(db, {
        studentRow,
        leaveType: typeCode,
        startIso,
        endIso,
        start: parseDateTime(startIso, '开始时间'),
        end: parseDateTime(endIso, '结束时间'),
        reason: String(leave.reason ?? ''),
        submittedAt: parseDateTime(submittedIso, '提交时间'),
        leaveRequestId: id,
      });
      if (status === 'approved_auto' && evaluation.outcome !== 'approved_auto') {
        problems.push(
          `${id}: 声明自动批准但规则复核未通过（${evaluation.results.find((item) => !item.passed)?.ruleCode ?? 'ENGINE'}）`,
        );
        continue;
      }
      if (status !== 'approved_auto' && evaluation.outcome === 'approved_auto') {
        problems.push(`${id}: 规则复核可通过但声明状态为 ${status}`);
        continue;
      }

      const stamp = String(leave.decidedAt ?? leave.submittedAt ?? new Date().toISOString());
      run(
        db,
        `INSERT INTO leave_requests
           (id, student_id, leave_type, start_at, end_at, reason, status, source,
            submitted_at, decided_at, decision_mode, decision_reason, rule_version,
            idempotency_key_hash, emergency_contact_json, row_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
        id,
        String(studentRow.id ?? ''),
        typeCode,
        startIso,
        endIso,
        String(leave.reason ?? ''),
        status,
        submittedIso,
        status === 'approved_auto' || status === 'approved_manual' || status === 'rejected_manual'
          ? String(leave.decidedAt ?? stamp)
          : status === 'cancelled'
            ? String(leave.decidedAt ?? stamp)
            : null,
        leave.decisionMode === 'auto' || leave.decisionMode === 'manual'
          ? leave.decisionMode
          : status === 'approved_auto'
            ? 'auto'
            : status === 'approved_manual' || status === 'rejected_manual'
              ? 'manual'
              : null,
        leave.decisionReason ?? null,
        status === 'evaluating' ? null : evaluation.version,
        submittedIso,
        submittedIso,
      );
      // every seed record carries its rule evaluation, plus a decision
      // timeline mirroring what the live state machine would have produced
      persistEvaluation(db, id, evaluation);
      writeSeedDecisions(db, id, {
        status,
        studentName: String(studentRow.name ?? ''),
        submittedAt: submittedIso,
        decidedAt:
          status === 'approved_auto' || status === 'approved_manual' || status === 'rejected_manual' || status === 'cancelled'
            ? String(leave.decidedAt ?? stamp)
            : null,
        decisionReason: leave.decisionReason ?? null,
        failedRuleMessage:
          evaluation.results.find((item) => !item.passed)?.message ?? '转入人工复核',
        evaluationOutcome: evaluation.outcome,
      });
      importedLeaves += 1;
    }

    // reject the whole import inside the transaction so nothing partial commits
    if (problems.length > 0) {
      throw new CampusServiceError(
        'SEED_CONSISTENCY_REJECTED',
        `种子数据一致性问题 ${problems.length} 条：${problems.slice(0, 5).join('；')}`,
        422,
      );
    }
    appendEvent(db, {
      action: 'admin.demo.import-seed',
      outcome: 'committed',
      actorRef: 'seed-importer',
      actorRole: 'campus-admin',
      resourceType: 'demo_database',
      resourceId: 'campus-demo',
      details: { importedLeaves, skippedLeaves },
    });
  });

  return {
    ok: true,
    action: 'demo-import-seed',
    importedLeaves,
    skippedLeaves,
    colleges: all(db, 'SELECT COUNT(*) AS total FROM colleges')[0]?.total ?? 0,
    classes: all(db, 'SELECT COUNT(*) AS total FROM classes')[0]?.total ?? 0,
    students: all(db, 'SELECT COUNT(*) AS total FROM students')[0]?.total ?? 0,
  };
}

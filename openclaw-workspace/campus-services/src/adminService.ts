/**
 * Admin-side deterministic service (plan sections 7/11):
 * manual approve/reject with optimistic concurrency, batch approve,
 * dashboard metrics, school data CRUD, rule configuration, audit listing
 * and demo reset. Every mutation appends a hash-chain audit event.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { appendEvent, auditRowToApi } from './audit.ts';
import {
  loadRuleSnapshot,
  resetRules,
  RULE_NAMES,
  seedDefaultRules,
  updateRules,
  type RuleUpdate,
} from './approvalEngine.ts';
import { rowToLeaveRequest } from './leaveService.ts';
import { CampusServiceError } from './errors.ts';
import { seedDemoBase } from './seed.ts';
import {
  all,
  get,
  isoInLocalOffset,
  now,
  nowIso,
  run,
  sha256,
  withTransaction,
  LEAVE_STATUSES,
  LEAVE_TYPE_LABELS,
  STATUS_LABELS,
  type LeaveTypeCode,
  type Row,
} from './db.ts';

export interface AdminActor {
  ref: string;
  name: string;
  idempotencyKey?: string;
}

const DECIDED_STATUSES = ['approved_auto', 'approved_manual', 'rejected_manual', 'cancelled'];

function sha256Hex(value: string): string {
  return sha256(value);
}

function requireLeave(db: DatabaseSync, id: string): Row {
  const row = get(db, 'SELECT * FROM leave_requests WHERE id = ?', id);
  if (!row) {
    throw new CampusServiceError('LEAVE_NOT_FOUND', '没有找到这条请假申请', 404);
  }
  return row;
}

function assertNotDecided(row: Row): void {
  const status = String(row.status ?? '');
  if (status !== 'manual_review') {
    throw new CampusServiceError(
      'LEAVE_ALREADY_DECIDED',
      `该申请当前状态为「${STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status}」，不能重复审批`,
      409,
    );
  }
}

function assertRowVersion(row: Row, expected: unknown): void {
  if (expected === undefined || expected === null) return;
  if (Number(row.row_version) !== Number(expected)) {
    throw new CampusServiceError(
      'LEAVE_ALREADY_DECIDED',
      '该申请已被其他操作更新，请刷新后重试',
      409,
    );
  }
}

// ---------------------------------------------------------------------------
// leave list / detail (admin view: full student numbers)
// ---------------------------------------------------------------------------

export interface LeaveListFilters {
  status?: string;
  collegeId?: string;
  classId?: string;
  leaveType?: string;
  keyword?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export function adminListLeaves(db: DatabaseSync, filters: LeaveListFilters): Record<string, unknown> {
  const page = Math.max(1, Math.floor(Number(filters.page ?? 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(filters.pageSize ?? 20))));
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status && LEAVE_STATUSES.includes(filters.status as never)) {
    where.push('l.status = ?');
    params.push(filters.status);
  }
  if (filters.collegeId) {
    where.push('s.college_id = ?');
    params.push(filters.collegeId);
  }
  if (filters.classId) {
    where.push('s.class_id = ?');
    params.push(filters.classId);
  }
  if (filters.leaveType) {
    where.push('l.leave_type = ?');
    params.push(filters.leaveType);
  }
  if (filters.dateFrom) {
    where.push('substr(l.submitted_at, 1, 10) >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push('substr(l.submitted_at, 1, 10) <= ?');
    params.push(filters.dateTo);
  }
  if (filters.keyword) {
    where.push('(l.id LIKE ? OR s.student_no LIKE ? OR s.name LIKE ? OR c.name LIKE ? OR k.name LIKE ?)');
    const like = `%${filters.keyword}%`;
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = get<{ total: unknown }>(
    db,
    `SELECT COUNT(*) AS total
     FROM leave_requests l
     JOIN students s ON s.id = l.student_id
     JOIN colleges c ON c.id = s.college_id
     JOIN classes k ON k.id = s.class_id
     ${whereSql}`,
    ...params,
  );
  const rows = all(
    db,
    `SELECT l.*, s.student_no, s.name AS student_name, s.status AS student_status,
            c.name AS college_name, k.name AS class_name
     FROM leave_requests l
     JOIN students s ON s.id = l.student_id
     JOIN colleges c ON c.id = s.college_id
     JOIN classes k ON k.id = s.class_id
     ${whereSql}
     ORDER BY l.submitted_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize,
  );
  return {
    ok: true,
    page,
    pageSize,
    total: Number(totalRow?.total ?? 0),
    items: rows.map((row) => ({
      id: String(row.id ?? ''),
      studentNo: String(row.student_no ?? ''),
      studentName: String(row.student_name ?? ''),
      studentStatus: String(row.student_status ?? ''),
      collegeName: String(row.college_name ?? ''),
      className: String(row.class_name ?? ''),
      leaveType: String(row.leave_type ?? ''),
      leaveTypeLabel: LEAVE_TYPE_LABELS[String(row.leave_type) as LeaveTypeCode] ?? '',
      startAt: String(row.start_at ?? ''),
      endAt: String(row.end_at ?? ''),
      status: String(row.status ?? ''),
      statusLabel: STATUS_LABELS[String(row.status) as keyof typeof STATUS_LABELS] ?? '',
      submittedAt: String(row.submitted_at ?? ''),
      decidedAt: row.decided_at === null ? null : String(row.decided_at),
      decisionMode: row.decision_mode === null ? null : String(row.decision_mode),
      rowVersion: Number(row.row_version ?? 1),
    })),
  };
}

export function adminLeaveDetail(db: DatabaseSync, id: string): Record<string, unknown> {
  requireLeave(db, id);
  const detail = adminDetailOf(db, id);
  return { ok: true, ...detail };
}

function adminDetailOf(db: DatabaseSync, id: string): Record<string, unknown> {
  const row = requireLeave(db, id);
  const request = rowToLeaveRequest(db, row);
  const student = get(db, 'SELECT * FROM students WHERE id = ?', String(row.student_id ?? ''));
  const evaluation = get(
    db,
    `SELECT * FROM leave_rule_evaluations WHERE leave_request_id = ?
     ORDER BY evaluated_at DESC LIMIT 1`,
    id,
  );
  const ruleResults = evaluation
    ? all(
        db,
        'SELECT rule_code, passed, actual_json, expected_json, message, sequence FROM leave_rule_results WHERE evaluation_id = ? ORDER BY sequence',
        String(evaluation.id),
      ).map((item) => ({
        ruleCode: String(item.rule_code),
        ruleName:
          RULE_NAMES[String(item.rule_code) as keyof typeof RULE_NAMES] ??
          String(item.rule_code),
        passed: Number(item.passed) === 1,
        actual: JSON.parse(String(item.actual_json ?? 'null')),
        expected: JSON.parse(String(item.expected_json ?? 'null')),
        message: String(item.message),
      }))
    : [];
  const timeline = all(
    db,
    'SELECT * FROM leave_decisions WHERE leave_request_id = ? ORDER BY rowid',
    id,
  ).map((item) => ({
    id: String(item.id),
    action: String(item.action),
    actorType: String(item.actor_type),
    actorName: item.actor_name === null ? null : String(item.actor_name),
    reason: item.reason === null ? null : String(item.reason),
    fromStatus: String(item.from_status),
    toStatus: String(item.to_status),
    createdAt: String(item.created_at),
  }));
  const historyRows = all(
    db,
    'SELECT id, status, start_at, end_at, submitted_at, decided_at FROM leave_requests WHERE student_id = ? ORDER BY submitted_at DESC LIMIT 20',
    String(row.student_id ?? ''),
  );
  return {
    request,
    student: student
      ? {
          id: String(student.id ?? ''),
          name: String(student.name ?? ''),
          status: String(student.status ?? ''),
        }
      : null,
    evaluation: evaluation
      ? {
          id: String(evaluation.id),
          outcome: String(evaluation.outcome),
          ruleVersion: Number(evaluation.rule_version),
          evaluatedAt: String(evaluation.evaluated_at),
          errorCode: evaluation.error_code === null ? null : String(evaluation.error_code),
        }
      : null,
    ruleResults,
    timeline,
    studentHistory: historyRows.map((item) => ({
      id: String(item.id ?? ''),
      status: String(item.status ?? ''),
      statusLabel: STATUS_LABELS[String(item.status) as keyof typeof STATUS_LABELS] ?? '',
      startAt: String(item.start_at ?? ''),
      endAt: String(item.end_at ?? ''),
      submittedAt: String(item.submitted_at ?? ''),
      decidedAt: item.decided_at === null ? null : String(item.decided_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// manual approve / reject / batch
// ---------------------------------------------------------------------------

export function adminApprove(
  db: DatabaseSync,
  actor: AdminActor,
  id: string,
  options: { reason?: string; rowVersion?: number } = {},
): Record<string, unknown> {
  const keyHash = actor.idempotencyKey ? sha256Hex(actor.idempotencyKey) : null;
  return withTransaction(db, () => {
    if (keyHash) {
      const prior = get(
        db,
        `SELECT * FROM leave_decisions
         WHERE idempotency_key_hash = ? AND action IN ('manual-approve','manual-reject')`,
        keyHash,
      );
      if (prior) {
        const existing = get(
          db,
          'SELECT * FROM leave_requests WHERE id = ?',
          String(prior.leave_request_id ?? ''),
        );
        return {
          ok: true,
          idempotent: true,
          request: existing ? rowToLeaveRequest(db, existing) : null,
        };
      }
    }
    const row = requireLeave(db, id);
    assertNotDecided(row);
    assertRowVersion(row, options.rowVersion);
    const reason = options.reason?.trim() || '';
    const summary = reason ? `已人工批准：${reason}` : '管理员已人工批准';
    const stamp = nowIso();
    run(
      db,
      `UPDATE leave_requests
       SET status = 'approved_manual', decided_at = ?, decision_mode = 'manual',
           decision_reason = ?, row_version = row_version + 1, updated_at = ?
       WHERE id = ?`,
      stamp,
      summary,
      stamp,
      id,
    );
    run(
      db,
      `INSERT INTO leave_decisions
        (id, leave_request_id, action, actor_type, actor_ref, actor_name, reason,
         from_status, to_status, request_id, idempotency_key_hash, created_at)
       VALUES (?, ?, 'manual-approve', 'admin', ?, ?, ?, 'manual_review', 'approved_manual', ?, ?, ?)`,
      `LD${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      id,
      actor.ref,
      actor.name,
      reason || null,
      process.env.CAMPUS_REQUEST_ID?.trim() || null,
      keyHash,
      stamp,
    );
    appendEvent(db, {
      action: 'admin.leave.approve',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'leave_request',
      resourceId: id,
      details: { idempotencyKeyHash: keyHash },
    });
    const updated = get(db, 'SELECT * FROM leave_requests WHERE id = ?', id);
    return { ok: true, idempotent: false, request: updated ? rowToLeaveRequest(db, updated) : null };
  });
}

export function adminReject(
  db: DatabaseSync,
  actor: AdminActor,
  id: string,
  options: { reason?: string; rowVersion?: number } = {},
): Record<string, unknown> {
  const reason = (options.reason ?? '').trim();
  if (reason.length < 4 || reason.length > 200) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '驳回原因必须在 4 到 200 个字符之间');
  }
  const keyHash = actor.idempotencyKey ? sha256Hex(actor.idempotencyKey) : null;
  return withTransaction(db, () => {
    if (keyHash) {
      const prior = get(
        db,
        `SELECT * FROM leave_decisions
         WHERE idempotency_key_hash = ? AND action IN ('manual-approve','manual-reject')`,
        keyHash,
      );
      if (prior) {
        const existing = get(
          db,
          'SELECT * FROM leave_requests WHERE id = ?',
          String(prior.leave_request_id ?? ''),
        );
        return {
          ok: true,
          idempotent: true,
          request: existing ? rowToLeaveRequest(db, existing) : null,
        };
      }
    }
    const row = requireLeave(db, id);
    assertNotDecided(row);
    assertRowVersion(row, options.rowVersion);
    const stamp = nowIso();
    run(
      db,
      `UPDATE leave_requests
       SET status = 'rejected_manual', decided_at = ?, decision_mode = 'manual',
           decision_reason = ?, row_version = row_version + 1, updated_at = ?
       WHERE id = ?`,
      stamp,
      reason,
      stamp,
      id,
    );
    run(
      db,
      `INSERT INTO leave_decisions
        (id, leave_request_id, action, actor_type, actor_ref, actor_name, reason,
         from_status, to_status, request_id, idempotency_key_hash, created_at)
       VALUES (?, ?, 'manual-reject', 'admin', ?, ?, ?, 'manual_review', 'rejected_manual', ?, ?, ?)`,
      `LD${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      id,
      actor.ref,
      actor.name,
      reason,
      process.env.CAMPUS_REQUEST_ID?.trim() || null,
      keyHash,
      stamp,
    );
    appendEvent(db, {
      action: 'admin.leave.reject',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'leave_request',
      resourceId: id,
      details: { idempotencyKeyHash: keyHash },
    });
    const updated = get(db, 'SELECT * FROM leave_requests WHERE id = ?', id);
    return { ok: true, idempotent: false, request: updated ? rowToLeaveRequest(db, updated) : null };
  });
}

export function adminBatchApprove(
  db: DatabaseSync,
  actor: AdminActor,
  ids: string[],
): Record<string, unknown> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '批量批准列表不能为空');
  }
  if (ids.length > 50) {
    throw new CampusServiceError('BATCH_TOO_LARGE', '单次批量批准最多 50 条', 400);
  }
  const results = ids.map((id) => {
    try {
      // One batch key must never collide across items: derive a per-item key
      // (hash(batchKey + leaveId) effectively) so the second approval does
      // not replay the first one's stored decision.
      const itemActor: AdminActor = actor.idempotencyKey
        ? { ...actor, idempotencyKey: `${actor.idempotencyKey}:${String(id)}` }
        : actor;
      const outcome = adminApprove(db, itemActor, String(id));
      return {
        id,
        ok: true,
        idempotent: Boolean(outcome.idempotent),
        status: String((outcome.request as Row | null)?.status ?? ''),
      };
    } catch (error) {
      if (error instanceof CampusServiceError) {
        const current = get(db, 'SELECT status FROM leave_requests WHERE id = ?', String(id));
        return {
          id,
          ok: false,
          code: error.code,
          message: error.message,
          status: current ? String(current.status ?? '') : null,
        };
      }
      return { id, ok: false, code: 'INTERNAL', message: '处理失败' };
    }
  });
  return {
    ok: true,
    total: ids.length,
    approved: results.filter((item) => item.ok).length,
    skipped: results.filter((item) => !item.ok).length,
    results,
  };
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

export function adminDashboard(db: DatabaseSync): Record<string, unknown> {
  const statusRows = all<{ status: unknown; total: unknown }>(
    db,
    'SELECT status, COUNT(*) AS total FROM leave_requests GROUP BY status',
  );
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[String(row.status)] = Number(row.total);
  const todayKey = nowIso().slice(0, 10);
  const todayRow = get<{ total: unknown }>(
    db,
    'SELECT COUNT(*) AS total FROM leave_requests WHERE substr(submitted_at, 1, 10) = ?',
    todayKey,
  );
  const decided =
    (byStatus.approved_auto ?? 0) + (byStatus.approved_manual ?? 0) + (byStatus.rejected_manual ?? 0);
  const trendRows = all<{ day: unknown; status: unknown; total: unknown }>(
    db,
    `SELECT substr(submitted_at, 1, 10) AS day, status, COUNT(*) AS total
     FROM leave_requests
     WHERE substr(submitted_at, 1, 10) >= date(?, '-6 days')
     GROUP BY day, status`,
    todayKey,
  );
  interface TrendDay {
    submitted: number;
    approvedAuto: number;
    manualApproved: number;
    manualRejected: number;
  }
  const trendMap = new Map<string, TrendDay>();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = isoInLocalOffset(new Date(now().getTime() - offset * 86_400_000)).slice(0, 10);
    trendMap.set(day, {
      submitted: 0,
      approvedAuto: 0,
      manualApproved: 0,
      manualRejected: 0,
    });
  }
  for (const row of trendRows) {
    const day = String(row.day ?? '');
    const entry = trendMap.get(day);
    if (!entry) continue;
    const total = Number(row.total);
    entry.submitted += total;
    const status = String(row.status ?? '');
    if (status === 'approved_auto') entry.approvedAuto += total;
    if (status === 'approved_manual') entry.manualApproved += total;
    if (status === 'rejected_manual') entry.manualRejected += total;
  }
  return {
    ok: true,
    metrics: {
      pendingManual: byStatus.manual_review ?? 0,
      todaySubmitted: Number(todayRow?.total ?? 0),
      autoApproved: byStatus.approved_auto ?? 0,
      manualApproved: byStatus.approved_manual ?? 0,
      manualRejected: byStatus.rejected_manual ?? 0,
      cancelled: byStatus.cancelled ?? 0,
      totalRequests: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      autoApproveRate: decided === 0 ? null : Math.round(((byStatus.approved_auto ?? 0) / decided) * 100),
    },
    trend: [...trendMap.entries()].map(([date, values]) => ({ date, ...values })),
  };
}

// ---------------------------------------------------------------------------
// school data CRUD
// ---------------------------------------------------------------------------

export function schoolGet(db: DatabaseSync): Record<string, unknown> {
  const rows = all(db, 'SELECT * FROM schools ORDER BY created_at');
  return {
    ok: true,
    schools: rows.map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      timezone: String(row.timezone ?? ''),
      status: String(row.status ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    })),
  };
}

export function schoolPatch(db: DatabaseSync, actor: AdminActor, input: Record<string, unknown>): Record<string, unknown> {
  const id = String(input.id ?? '');
  const row = get(db, 'SELECT * FROM schools WHERE id = ?', id);
  if (!row) throw new CampusServiceError('SCHOOL_NOT_FOUND', '未找到该学校', 404);
  const name = input.name === undefined ? String(row.name ?? '') : String(input.name).trim();
  const timezone = input.timezone === undefined ? String(row.timezone ?? '') : String(input.timezone).trim();
  const status = input.status === undefined ? String(row.status ?? '') : String(input.status);
  if (!name) throw new CampusServiceError('SCHOOL_DATA_INVALID', '学校名称不能为空');
  if (!timezone) throw new CampusServiceError('SCHOOL_DATA_INVALID', '时区不能为空');
  if (!['active', 'inactive'].includes(status)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '学校状态不合法');
  }
  const stamp = nowIso();
  return withTransaction(db, () => {
    run(
      db,
      'UPDATE schools SET name = ?, timezone = ?, status = ?, updated_at = ? WHERE id = ?',
      name,
      timezone,
      status,
      stamp,
      id,
    );
    appendEvent(db, {
      action: 'admin.school.patch',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'school',
      resourceId: id,
      details: null,
    });
    return { ok: true };
  });
}

function collegeToApi(row: Row): Record<string, unknown> {
  return {
    id: String(row.id ?? ''),
    schoolId: String(row.school_id ?? ''),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    status: String(row.status ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

export function collegesList(db: DatabaseSync): Record<string, unknown> {
  return { ok: true, colleges: all(db, 'SELECT * FROM colleges ORDER BY code').map(collegeToApi) };
}

export function collegesCreate(
  db: DatabaseSync,
  actor: AdminActor,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const school = get(db, 'SELECT id FROM schools ORDER BY created_at LIMIT 1');
  if (!school) throw new CampusServiceError('SCHOOL_NOT_FOUND', '请先初始化学校数据', 404);
  const code = String(input.code ?? '').trim();
  const name = String(input.name ?? '').trim();
  if (!/^[A-Z0-9-]{2,16}$/.test(code)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '学院编号需为 2-16 位大写字母、数字或连字符');
  }
  if (!name || name.length > 80) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '学院名称长度需在 1 到 80 字之间');
  }
  const stamp = nowIso();
  return withTransaction(db, () => {
    const conflict = get(
      db,
      'SELECT id FROM colleges WHERE school_id = ? AND code = ?',
      String(school.id ?? ''),
      code,
    );
    if (conflict) {
      throw new CampusServiceError('COLLEGE_CODE_CONFLICT', '该学院编号已存在', 409);
    }
    const id = `COLLEGE-${code}`;
    run(
      db,
      `INSERT INTO colleges (id, school_id, code, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      id,
      String(school.id ?? ''),
      code,
      name,
      stamp,
      stamp,
    );
    appendEvent(db, {
      action: 'admin.college.create',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'college',
      resourceId: id,
      details: null,
    });
    return { ok: true, college: collegeToApi(get(db, 'SELECT * FROM colleges WHERE id = ?', id) as Row) };
  });
}

export function collegesPatch(
  db: DatabaseSync,
  actor: AdminActor,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = String(input.id ?? '');
  const row = get(db, 'SELECT * FROM colleges WHERE id = ?', id);
  if (!row) throw new CampusServiceError('COLLEGE_NOT_FOUND', '未找到该学院', 404);
  const name = input.name === undefined ? String(row.name ?? '') : String(input.name).trim();
  const status = input.status === undefined ? String(row.status ?? '') : String(input.status);
  if (!name || name.length > 80) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '学院名称长度需在 1 到 80 字之间');
  }
  if (!['active', 'inactive'].includes(status)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '学院状态不合法');
  }
  const stamp = nowIso();
  return withTransaction(db, () => {
    run(db, 'UPDATE colleges SET name = ?, status = ?, updated_at = ? WHERE id = ?', name, status, stamp, id);
    appendEvent(db, {
      action: 'admin.college.patch',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'college',
      resourceId: id,
      details: null,
    });
    return { ok: true };
  });
}

function classToApi(row: Row): Record<string, unknown> {
  return {
    id: String(row.id ?? ''),
    collegeId: String(row.college_id ?? ''),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    gradeYear: Number(row.grade_year ?? 0),
    majorName: String(row.major_name ?? ''),
    status: String(row.status ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

export function classesList(db: DatabaseSync, collegeId?: string): Record<string, unknown> {
  const rows = collegeId
    ? all(db, 'SELECT * FROM classes WHERE college_id = ? ORDER BY code', collegeId)
    : all(db, 'SELECT * FROM classes ORDER BY code');
  return { ok: true, classes: rows.map(classToApi) };
}

export function classesCreate(
  db: DatabaseSync,
  actor: AdminActor,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const collegeId = String(input.collegeId ?? '');
  const college = get(db, 'SELECT * FROM colleges WHERE id = ?', collegeId);
  if (!college) throw new CampusServiceError('COLLEGE_NOT_FOUND', '未找到所属学院', 404);
  const code = String(input.code ?? '').trim();
  const name = String(input.name ?? '').trim();
  const majorName = String(input.majorName ?? '').trim();
  const gradeYear = Number(input.gradeYear ?? 0);
  if (!/^[A-Z0-9-]{2,16}$/.test(code)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '班级编号需为 2-16 位大写字母、数字或连字符');
  }
  if (!name || name.length > 80) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '班级名称长度需在 1 到 80 字之间');
  }
  if (!majorName || majorName.length > 80) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '专业名称长度需在 1 到 80 字之间');
  }
  if (!(gradeYear >= 2000 && gradeYear <= 2100)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '年级不合法');
  }
  const stamp = nowIso();
  return withTransaction(db, () => {
    const conflict = get(
      db,
      'SELECT id FROM classes WHERE college_id = ? AND code = ?',
      collegeId,
      code,
    );
    if (conflict) {
      throw new CampusServiceError('CLASS_CODE_CONFLICT', '该班级编号已存在', 409);
    }
    const id = `CLASS-${String(college.code ?? '')}-${code}`;
    run(
      db,
      `INSERT INTO classes (id, college_id, code, name, grade_year, major_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id,
      collegeId,
      code,
      name,
      gradeYear,
      majorName,
      stamp,
      stamp,
    );
    appendEvent(db, {
      action: 'admin.class.create',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'class',
      resourceId: id,
      details: null,
    });
    return { ok: true, class: classToApi(get(db, 'SELECT * FROM classes WHERE id = ?', id) as Row) };
  });
}

export function classesPatch(
  db: DatabaseSync,
  actor: AdminActor,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = String(input.id ?? '');
  const row = get(db, 'SELECT * FROM classes WHERE id = ?', id);
  if (!row) throw new CampusServiceError('CLASS_NOT_FOUND', '未找到该班级', 404);
  const name = input.name === undefined ? String(row.name ?? '') : String(input.name).trim();
  const majorName =
    input.majorName === undefined ? String(row.major_name ?? '') : String(input.majorName).trim();
  const status = input.status === undefined ? String(row.status ?? '') : String(input.status);
  if (!name || name.length > 80) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '班级名称长度需在 1 到 80 字之间');
  }
  if (!majorName || majorName.length > 80) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '专业名称长度需在 1 到 80 字之间');
  }
  if (!['active', 'inactive'].includes(status)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '班级状态不合法');
  }
  const stamp = nowIso();
  return withTransaction(db, () => {
    run(
      db,
      'UPDATE classes SET name = ?, major_name = ?, status = ?, updated_at = ? WHERE id = ?',
      name,
      majorName,
      status,
      stamp,
      id,
    );
    appendEvent(db, {
      action: 'admin.class.patch',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'class',
      resourceId: id,
      details: null,
    });
    return { ok: true };
  });
}

function studentToApi(row: Row): Record<string, unknown> {
  return {
    id: String(row.id ?? ''),
    studentNo: String(row.student_no ?? ''),
    name: String(row.name ?? ''),
    collegeId: String(row.college_id ?? ''),
    classId: String(row.class_id ?? ''),
    enrollmentYear: Number(row.enrollment_year ?? 0),
    status: String(row.status ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

export function studentsList(
  db: DatabaseSync,
  filters: { collegeId?: string; classId?: string; keyword?: string; page?: number; pageSize?: number },
): Record<string, unknown> {
  const page = Math.max(1, Math.floor(Number(filters.page ?? 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(filters.pageSize ?? 20))));
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.collegeId) {
    where.push('s.college_id = ?');
    params.push(filters.collegeId);
  }
  if (filters.classId) {
    where.push('s.class_id = ?');
    params.push(filters.classId);
  }
  if (filters.keyword) {
    where.push('(s.student_no LIKE ? OR s.name LIKE ?)');
    const like = `%${filters.keyword}%`;
    params.push(like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<{ total: unknown }>(
    db,
    `SELECT COUNT(*) AS total FROM students s ${whereSql}`,
    ...params,
  );
  const rows = all(
    db,
    `SELECT s.*, c.name AS college_name, k.name AS class_name FROM students s
     JOIN colleges c ON c.id = s.college_id JOIN classes k ON k.id = s.class_id
     ${whereSql} ORDER BY s.student_no LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize,
  );
  return {
    ok: true,
    page,
    pageSize,
    total: Number(total?.total ?? 0),
    students: rows.map((row) => ({
      ...studentToApi(row),
      collegeName: String(row.college_name ?? ''),
      className: String(row.class_name ?? ''),
    })),
  };
}

export function studentsCreate(
  db: DatabaseSync,
  actor: AdminActor,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const studentNo = String(input.studentNo ?? '').trim();
  const name = String(input.name ?? '').trim();
  const collegeId = String(input.collegeId ?? '');
  const classId = String(input.classId ?? '');
  const enrollmentYear = Number(input.enrollmentYear ?? 0);
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(studentNo)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '学号需为 4-32 位字母、数字、下划线或连字符');
  }
  if (!name || name.length > 40) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '姓名长度需在 1 到 40 字之间');
  }
  if (!get(db, 'SELECT id FROM colleges WHERE id = ?', collegeId)) {
    throw new CampusServiceError('COLLEGE_NOT_FOUND', '未找到所属学院', 404);
  }
  if (!get(db, 'SELECT id FROM classes WHERE id = ?', classId)) {
    throw new CampusServiceError('CLASS_NOT_FOUND', '未找到所属班级', 404);
  }
  if (!(enrollmentYear >= 2000 && enrollmentYear <= 2100)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '入学年份不合法');
  }
  const stamp = nowIso();
  return withTransaction(db, () => {
    if (get(db, 'SELECT id FROM students WHERE student_no = ?', studentNo)) {
      throw new CampusServiceError('STUDENT_NO_CONFLICT', '该学号已存在', 409);
    }
    run(
      db,
      `INSERT INTO students (id, student_no, name, college_id, class_id, enrollment_year, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      studentNo,
      studentNo,
      name,
      collegeId,
      classId,
      enrollmentYear,
      stamp,
      stamp,
    );
    appendEvent(db, {
      action: 'admin.student.create',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'student',
      resourceId: studentNo,
      details: null,
    });
    return { ok: true, student: studentToApi(get(db, 'SELECT * FROM students WHERE id = ?', studentNo) as Row) };
  });
}

export function studentsPatch(
  db: DatabaseSync,
  actor: AdminActor,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const id = String(input.id ?? '');
  const row = get(db, 'SELECT * FROM students WHERE id = ?', id);
  if (!row) throw new CampusServiceError('STUDENT_NOT_FOUND', '未找到该学生', 404);
  const name = input.name === undefined ? String(row.name ?? '') : String(input.name).trim();
  const status = input.status === undefined ? String(row.status ?? '') : String(input.status);
  const collegeId = input.collegeId === undefined ? String(row.college_id ?? '') : String(input.collegeId);
  const classId = input.classId === undefined ? String(row.class_id ?? '') : String(input.classId);
  if (!name || name.length > 40) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '姓名长度需在 1 到 40 字之间');
  }
  if (!['active', 'suspended', 'graduated'].includes(status)) {
    throw new CampusServiceError('SCHOOL_DATA_INVALID', '学生状态不合法');
  }
  if (!get(db, 'SELECT id FROM colleges WHERE id = ?', collegeId)) {
    throw new CampusServiceError('COLLEGE_NOT_FOUND', '未找到所属学院', 404);
  }
  if (!get(db, 'SELECT id FROM classes WHERE id = ?', classId)) {
    throw new CampusServiceError('CLASS_NOT_FOUND', '未找到所属班级', 404);
  }
  const stamp = nowIso();
  return withTransaction(db, () => {
    run(
      db,
      'UPDATE students SET name = ?, status = ?, college_id = ?, class_id = ?, updated_at = ? WHERE id = ?',
      name,
      status,
      collegeId,
      classId,
      stamp,
      id,
    );
    appendEvent(db, {
      action: 'admin.student.patch',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'student',
      resourceId: id,
      details: { status },
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// rules / audit / reset
// ---------------------------------------------------------------------------

export function rulesGet(db: DatabaseSync): Record<string, unknown> {
  const snapshot = loadRuleSnapshot(db);
  return {
    ok: true,
    version: snapshot.version,
    rules: Object.fromEntries(
      Object.entries(snapshot.rules).map(([code, spec]) => [
        code,
        {
          name: spec?.name ?? code,
          enabled: spec?.enabled ?? false,
          config: spec?.config ?? {},
        },
      ]),
    ),
  };
}

export function rulesPut(
  db: DatabaseSync,
  actor: AdminActor,
  updates: RuleUpdate[],
): Record<string, unknown> {
  withTransaction(db, () => {
    updateRules(db, updates, actor.ref);
    appendEvent(db, {
      action: 'admin.rules.update',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'approval_rules',
      resourceId: '',
      details: { count: updates.length },
    });
  });
  return rulesGet(db);
}

export function rulesReset(db: DatabaseSync, actor: AdminActor): Record<string, unknown> {
  withTransaction(db, () => {
    resetRules(db, actor.ref);
    appendEvent(db, {
      action: 'admin.rules.reset',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'approval_rules',
      resourceId: '',
      details: null,
    });
  });
  return rulesGet(db);
}

export function auditList(
  db: DatabaseSync,
  filters: { action?: string; page?: number; pageSize?: number },
): Record<string, unknown> {
  const page = Math.max(1, Math.floor(Number(filters.page ?? 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(filters.pageSize ?? 20))));
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.action) {
    where.push('action LIKE ?');
    params.push(`%${filters.action}%`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<{ total: unknown }>(
    db,
    `SELECT COUNT(*) AS total FROM audit_events ${whereSql}`,
    ...params,
  );
  const rows = all(
    db,
    `SELECT * FROM audit_events ${whereSql} ORDER BY sequence DESC LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize,
  );
  return {
    ok: true,
    page,
    pageSize,
    total: Number(total?.total ?? 0),
    events: rows.map(auditRowToApi),
  };
}

export const DEMO_RESET_PHRASE = 'RESET-DEMO';

export function demoReset(db: DatabaseSync, actor: AdminActor, phrase: string): Record<string, unknown> {
  if (phrase !== DEMO_RESET_PHRASE) {
    throw new CampusServiceError(
      'DEMO_RESET_CONFIRMATION_REQUIRED',
      `请输入确认短语 ${DEMO_RESET_PHRASE} 以重置演示数据`,
    );
  }
  withTransaction(db, () => {
    for (const table of [
      'leave_rule_results',
      'leave_rule_evaluations',
      'leave_decisions',
      'leave_approval_jobs',
      'leave_requests',
      'audit_events',
      'students',
      'classes',
      'colleges',
      'schools',
    ]) {
      run(db, `DELETE FROM ${table}`);
    }
    seedDemoBase(db);
    appendEvent(db, {
      action: 'admin.demo.reset',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin',
      resourceType: 'demo_database',
      resourceId: 'campus-demo',
      details: null,
    });
  });
  return { ok: true, reset: true };
}

export { DECIDED_STATUSES };

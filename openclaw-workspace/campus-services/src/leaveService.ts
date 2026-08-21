/**
 * Leave-request state machine and transactional service (plan sections 8/12).
 *
 * Student-facing contract preserved from the legacy engine:
 * - subcommands create / list / cancel / verify-audit with the same flags;
 * - `LVYYYYMMDD-XXXXXX` ids, CAMPUS_IDEMPOTENCY_KEY / CAMPUS_REQUEST_ID env;
 * - same-key replay returns the original record, same content returns the
 *   existing record as a duplicate;
 * - stdout single-line JSON, exit 0/2/1.
 *
 * Student submission and administrator-agent approval are intentionally
 * separated. Creation commits an `evaluating` request plus a durable approval
 * job; the private campus-admin Agent later runs the deterministic approval
 * Skill and transitions it to approved_auto or manual_review.
 */
import type { DatabaseSync } from 'node:sqlite';

import { actorRefForStudent, appendEvent, verifyChain } from './audit.ts';
import { CampusServiceError } from './errors.ts';
import {
  all,
  canonicalJson,
  get,
  idempotencyKey,
  isoInLocalOffset,
  leaveRequestId,
  now,
  nowIso,
  parseDateTime,
  run,
  sha256,
  shortId,
  str,
  withTransaction,
  LEAVE_TYPE_BY_LABEL,
  LEAVE_TYPE_LABELS,
  STATUS_LABELS,
  type LeaveTypeCode,
  type Row,
} from './db.ts';

const STUDENT_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
const PHONE_RE = /^[0-9+() -]{6,24}$/;

export interface CreateLeaveInput {
  studentId: string;
  studentName: string;
  college: string;
  className: string;
  leaveType: string;
  start: string;
  end: string;
  reason: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
}

export function cleanText(value: unknown, label: string, minimum: number, maximum: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text.length < minimum || text.length > maximum) {
    throw new CampusServiceError(
      'LEAVE_INVALID_INPUT',
      `${label}长度必须在 ${minimum} 到 ${maximum} 个字符之间`,
    );
  }
  return text;
}

function requireStudent(db: DatabaseSync, studentId: string): Row {
  const row = get(
    db,
    `SELECT s.*, c.name AS college_name, c.code AS college_code,
            k.name AS class_name, k.code AS class_code
     FROM students s
     JOIN colleges c ON c.id = s.college_id
     JOIN classes k ON k.id = s.class_id
     WHERE s.id = ?`,
    studentId,
  );
  if (!row) {
    throw new CampusServiceError('LEAVE_STUDENT_NOT_FOUND', '未找到该学号的学生档案', 404);
  }
  return row;
}

function contactFingerprintParts(contactJson: string | null): {
  name: string;
  phone: string;
} {
  if (!contactJson) return { name: '', phone: '' };
  const parsed = JSON.parse(contactJson) as { name?: unknown; phone?: unknown };
  return { name: String(parsed.name ?? ''), phone: String(parsed.phone ?? '') };
}

function requestFingerprint(input: {
  studentId: string;
  leaveTypeLabel: string;
  startIso: string;
  endIso: string;
  reason: string;
  contactName: string;
  contactPhone: string;
}): string {
  return sha256(
    canonicalJson({
      studentId: input.studentId,
      leaveType: input.leaveTypeLabel,
      start: input.startIso,
      end: input.endIso,
      reason: input.reason,
      emergencyContactName: input.contactName,
      emergencyContactPhone: input.contactPhone,
    }),
  );
}

function rowFingerprint(row: Row): string {
  const contact = contactFingerprintParts(
    row.emergency_contact_json === null || row.emergency_contact_json === undefined
      ? null
      : String(row.emergency_contact_json),
  );
  return requestFingerprint({
    studentId: String(row.student_id ?? ''),
    leaveTypeLabel: LEAVE_TYPE_LABELS[String(row.leave_type) as LeaveTypeCode] ?? '',
    startIso: String(row.start_at ?? ''),
    endIso: String(row.end_at ?? ''),
    reason: String(row.reason ?? ''),
    contactName: contact.name,
    contactPhone: contact.phone,
  });
}

export function decisionSummaryOf(row: Row): string | null {
  const mode = row.decision_mode === null ? null : String(row.decision_mode);
  const reason = row.decision_reason === null ? null : String(row.decision_reason);
  if (mode === 'auto' || mode === 'manual') return reason;
  return null;
}

function failedRulesOf(db: DatabaseSync, leaveRequestId: string): Array<{
  ruleCode: string;
  ruleName: string;
  message: string;
}> {
  const evaluation = get<{ id: unknown }>(
    db,
    `SELECT id FROM leave_rule_evaluations WHERE leave_request_id = ?
     ORDER BY evaluated_at DESC LIMIT 1`,
    leaveRequestId,
  );
  if (!evaluation) return [];
  return all<{ rule_code: unknown; passed: unknown; message: unknown }>(
    db,
    'SELECT rule_code, passed, message FROM leave_rule_results WHERE evaluation_id = ? ORDER BY sequence',
    String(evaluation.id),
  )
    .filter((item) => Number(item.passed) !== 1)
    .map((item) => ({
      ruleCode: String(item.rule_code),
      ruleName: ruleNameOf(String(item.rule_code)),
      message: String(item.message),
    }));
}

function ruleNameOf(code: string): string {
  const names: Record<string, string> = {
    LEAVE_TYPE_ALLOWED: '假别范围',
    REASON_COMPLETE: '原因完整',
    FUTURE_REQUEST: '提前申请',
    DATE_RANGE_ALLOWED: '申请区间',
    SAME_DAY: '同日请假',
    DURATION_LIMIT: '时长上限',
    NO_OVERLAP: '时段不重叠',
    FREQUENCY_LIMIT: '频次上限',
    STUDENT_ACTIVE: '学生在读',
  };
  return names[code] ?? code;
}

function ruleSummaryOf(db: DatabaseSync, row: Row): {
  version: number;
  passedCount: number;
  totalCount: number;
} | null {
  if (row.rule_version === null || row.rule_version === undefined) return null;
  const evaluation = get<{ id: unknown }>(
    db,
    `SELECT id FROM leave_rule_evaluations WHERE leave_request_id = ?
     ORDER BY evaluated_at DESC LIMIT 1`,
    String(row.id),
  );
  if (!evaluation) return null;
  const stats = get<{ total: unknown; passed: unknown }>(
    db,
    'SELECT COUNT(*) AS total, SUM(passed) AS passed FROM leave_rule_results WHERE evaluation_id = ?',
    String(evaluation.id),
  );
  return {
    version: Number(row.rule_version),
    passedCount: Number(stats?.passed ?? 0),
    totalCount: Number(stats?.total ?? 0),
  };
}

/** Map a leave_requests row to the API shape (legacy-compatible + new fields). */
export function rowToLeaveRequest(db: DatabaseSync, row: Row): Record<string, unknown> {
  const student = get(
    db,
    `SELECT s.name AS student_name, s.student_no, c.name AS college_name, k.name AS class_name
     FROM students s JOIN colleges c ON c.id = s.college_id JOIN classes k ON k.id = s.class_id
     WHERE s.id = ?`,
    String(row.student_id ?? ''),
  );
  const status = String(row.status ?? '');
  const contact = contactFingerprintParts(
    row.emergency_contact_json === null || row.emergency_contact_json === undefined
      ? null
      : String(row.emergency_contact_json),
  );
  return {
    id: String(row.id ?? ''),
    studentId: String(student?.student_no ?? row.student_id ?? ''),
    studentName: String(student?.student_name ?? ''),
    college: String(student?.college_name ?? ''),
    className: String(student?.class_name ?? ''),
    leaveType: LEAVE_TYPE_LABELS[String(row.leave_type) as LeaveTypeCode] ?? String(row.leave_type ?? ''),
    start: String(row.start_at ?? ''),
    end: String(row.end_at ?? ''),
    reason: String(row.reason ?? ''),
    emergencyContact:
      contact.name && contact.phone ? { name: contact.name, phone: contact.phone } : null,
    status,
    statusLabel: STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status,
    source: String(row.source ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    submittedAt: String(row.submitted_at ?? ''),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
    decisionMode: row.decision_mode === null ? null : String(row.decision_mode),
    decisionSummary: decisionSummaryOf(row),
    ruleSummary: ruleSummaryOf(db, row),
    failedRules: status === 'manual_review' ? failedRulesOf(db, String(row.id)) : [],
    rowVersion: Number(row.row_version ?? 1),
    evidence: {
      requestFingerprint: rowFingerprint(row),
      idempotencyKeyHash:
        row.idempotency_key_hash === null || row.idempotency_key_hash === undefined
          ? null
          : String(row.idempotency_key_hash),
      confirmationRequired: true,
      rulesVersion:
        row.rule_version === null || row.rule_version === undefined
          ? null
          : `campus-leave-v${String(row.rule_version)}`,
    },
  };
}

export function autoDecisionSummary(evaluation: import('./approvalEngine.ts').Evaluation): string {
  const passed = evaluation.results.filter((result) => result.passed).length;
  return `全部 ${passed} 项低风险规则通过（规则版本 ${evaluation.version}）`;
}

export function insertDecision(
  db: DatabaseSync,
  leaveRequestId: string,
  input: {
    action: string;
    actorType: string;
    actorRef: string;
    actorName: string | null;
    reason: string | null;
    fromStatus: string;
    toStatus: string;
    idempotencyKeyHash: string | null;
    createdAt: string;
  },
): void {
  run(
    db,
    `INSERT INTO leave_decisions
      (id, leave_request_id, action, actor_type, actor_ref, actor_name, reason,
       from_status, to_status, request_id, idempotency_key_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    shortId('LD'),
    leaveRequestId,
    input.action,
    input.actorType,
    input.actorRef,
    input.actorName,
    input.reason,
    input.fromStatus,
    input.toStatus,
    process.env.CAMPUS_REQUEST_ID?.trim() || null,
    input.idempotencyKeyHash,
    input.createdAt,
  );
}

// ---------------------------------------------------------------------------
// create (submit + auto-evaluate in one transaction)
// ---------------------------------------------------------------------------

export function createLeave(db: DatabaseSync, input: CreateLeaveInput): Record<string, unknown> {
  if (!STUDENT_ID_RE.test(input.studentId)) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '学号格式不正确');
  }
  cleanText(input.studentName, '姓名', 1, 40);
  cleanText(input.college, '学院', 1, 80);
  cleanText(input.className, '班级', 1, 80);
  const typeCode = LEAVE_TYPE_BY_LABEL[input.leaveType];
  if (!typeCode) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '请假类型必须是病假、事假、公假或其他');
  }
  let start: Date;
  let end: Date;
  try {
    start = parseDateTime(input.start, '开始时间');
    end = parseDateTime(input.end, '结束时间');
  } catch (error) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', (error as Error).message);
  }
  if (end <= start) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '结束时间必须晚于开始时间');
  }
  if (end.getTime() - start.getTime() > 90 * 86_400_000) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '单次请假不能超过 90 天');
  }
  let reason: string;
  try {
    reason = cleanText(input.reason, '请假原因', 4, 200);
  } catch (error) {
    if (error instanceof CampusServiceError) throw error;
    throw new CampusServiceError('LEAVE_INVALID_INPUT', (error as Error).message);
  }
  let key = '';
  try {
    key = idempotencyKey();
  } catch (error) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', (error as Error).message);
  }
  const keyHash = key ? sha256(key) : null;

  let contactName = '';
  let contactPhone = '';
  if (input.emergencyContactName || input.emergencyContactPhone) {
    if (!(input.emergencyContactName && input.emergencyContactPhone)) {
      throw new CampusServiceError('LEAVE_INVALID_INPUT', '紧急联系人姓名和手机号需要同时提供');
    }
    contactName = cleanText(input.emergencyContactName, '紧急联系人姓名', 1, 40);
    contactPhone = input.emergencyContactPhone.trim();
    if (!PHONE_RE.test(contactPhone)) {
      throw new CampusServiceError('LEAVE_INVALID_INPUT', '紧急联系人手机号格式不正确');
    }
  }

  const startIso = isoInLocalOffset(start);
  const endIso = isoInLocalOffset(end);
  const fingerprint = requestFingerprint({
    studentId: input.studentId,
    leaveTypeLabel: input.leaveType,
    startIso,
    endIso,
    reason,
    contactName,
    contactPhone,
  });
  const actorRef = actorRefForStudent(input.studentId);

  return withTransaction(db, () => {
    const student = requireStudent(db, input.studentId);

    if (keyHash) {
      const keyed = get(
        db,
        'SELECT * FROM leave_requests WHERE idempotency_key_hash = ?',
        keyHash,
      );
      if (keyed) {
        if (rowFingerprint(keyed) !== fingerprint) {
          throw new CampusServiceError(
            'IDEMPOTENCY_CONFLICT',
            '同一个幂等键不能用于不同的请假内容',
            409,
          );
        }
        appendEvent(db, {
          action: 'leave.create',
          outcome: 'replayed',
          actorRef,
          actorRole: 'student',
          resourceType: 'leave_request',
          resourceId: String(keyed.id ?? ''),
          details: { idempotencyKeyHash: keyHash },
        });
        return {
          ok: true,
          duplicate: true,
          idempotent: true,
          request: rowToLeaveRequest(db, keyed),
        };
      }
    }

    const duplicate = get(
      db,
      `SELECT * FROM leave_requests
       WHERE student_id = ? AND start_at = ? AND end_at = ? AND reason = ?
         AND status NOT IN ('cancelled','rejected_manual')
       LIMIT 1`,
      input.studentId,
      startIso,
      endIso,
      reason,
    );
    if (duplicate) {
      appendEvent(db, {
        action: 'leave.create',
        outcome: 'duplicate',
        actorRef,
        actorRole: 'student',
        resourceType: 'leave_request',
        resourceId: String(duplicate.id ?? ''),
        details: { requestFingerprint: fingerprint },
      });
      return {
        ok: true,
        duplicate: true,
        idempotent: true,
        request: rowToLeaveRequest(db, duplicate),
      };
    }

    const stamp = nowIso();
    const requestIdValue = leaveRequestId();
    appendEvent(db, {
      action: 'leave.create',
      outcome: 'attempt',
      actorRef,
      actorRole: 'student',
      resourceType: 'leave_request',
      resourceId: requestIdValue,
      details: {
        requestFingerprint: fingerprint,
        idempotencyKeyHash: keyHash,
      },
    });
    run(
      db,
      `INSERT INTO leave_requests
        (id, student_id, leave_type, start_at, end_at, reason, status, source,
         submitted_at, idempotency_key_hash, emergency_contact_json,
         row_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'evaluating', 'campus-assistant', ?, ?, ?, 1, ?, ?)`,
      requestIdValue,
      input.studentId,
      typeCode,
      startIso,
      endIso,
      reason,
      stamp,
      keyHash,
      contactName && contactPhone
        ? canonicalJson({ name: contactName, phone: contactPhone })
        : null,
      stamp,
      stamp,
    );

    insertDecision(db, requestIdValue, {
      action: 'submitted',
      actorType: 'student',
      actorRef,
      actorName: String(student.name ?? ''),
      reason: null,
      fromStatus: 'none',
      toStatus: 'evaluating',
      idempotencyKeyHash: keyHash,
      createdAt: stamp,
    });

    run(
      db,
      `INSERT INTO leave_approval_jobs
        (id, leave_request_id, status, attempts, available_at, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
      shortId('AJ'),
      requestIdValue,
      stamp,
      stamp,
      stamp,
    );

    appendEvent(db, {
      action: 'leave.create',
      outcome: 'committed',
      actorRef,
      actorRole: 'student',
      resourceType: 'leave_request',
      resourceId: requestIdValue,
      details: {
        requestFingerprint: fingerprint,
        idempotencyKeyHash: keyHash,
        status: 'evaluating',
        approvalOwner: 'agent:campus-admin',
      },
    });

    const created = get(db, 'SELECT * FROM leave_requests WHERE id = ?', requestIdValue);
    return {
      ok: true,
      duplicate: false,
      idempotent: false,
      request: created ? rowToLeaveRequest(db, created) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// list / detail / cancel / audit
// ---------------------------------------------------------------------------

export function listLeaves(
  db: DatabaseSync,
  studentId: string,
  limit = 10,
): Record<string, unknown> {
  if (!STUDENT_ID_RE.test(studentId)) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '学号格式不正确');
  }
  const rows = all(
    db,
    'SELECT * FROM leave_requests WHERE student_id = ? ORDER BY submitted_at DESC LIMIT ?',
    studentId,
    limit,
  );
  return {
    ok: true,
    requests: rows.map((row) => rowToLeaveRequest(db, row)),
    total: rows.length,
  };
}

export function leaveDetail(
  db: DatabaseSync,
  studentId: string | null,
  leaveRequestId: string,
): Record<string, unknown> {
  const row = get(db, 'SELECT * FROM leave_requests WHERE id = ?', leaveRequestId);
  if (!row) {
    throw new CampusServiceError('LEAVE_NOT_FOUND', '没有找到这条请假申请', 404);
  }
  if (studentId !== null && String(row.student_id ?? '') !== studentId) {
    throw new CampusServiceError('LEAVE_FORBIDDEN', '只能查看本人的请假申请', 403);
  }
  const request = rowToLeaveRequest(db, row);
  const evaluation = get(
    db,
    `SELECT * FROM leave_rule_evaluations WHERE leave_request_id = ?
     ORDER BY evaluated_at DESC LIMIT 1`,
    leaveRequestId,
  );
  const ruleResults = evaluation
    ? all(
        db,
        'SELECT rule_code, passed, actual_json, expected_json, message, sequence FROM leave_rule_results WHERE evaluation_id = ? ORDER BY sequence',
        String(evaluation.id),
      ).map((item) => ({
        ruleCode: String(item.rule_code),
        ruleName: ruleNameOf(String(item.rule_code)),
        passed: Number(item.passed) === 1,
        actual: JSON.parse(String(item.actual_json ?? 'null')),
        expected: JSON.parse(String(item.expected_json ?? 'null')),
        message: String(item.message),
      }))
    : [];
  const timeline = all(
    db,
    'SELECT * FROM leave_decisions WHERE leave_request_id = ? ORDER BY rowid',
    leaveRequestId,
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
  const history = get<{ total: unknown }>(
    db,
    'SELECT COUNT(*) AS total FROM leave_requests WHERE student_id = ?',
    String(row.student_id ?? ''),
  );
  return {
    ok: true,
    request,
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
    studentHistoryCount: Number(history?.total ?? 0),
  };
}

export function cancelLeave(
  db: DatabaseSync,
  studentId: string,
  leaveRequestId: string,
  reasonInput?: string,
): Record<string, unknown> {
  if (!STUDENT_ID_RE.test(studentId)) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', '学号格式不正确');
  }
  const reason = cleanText(reasonInput ?? '', '取消原因', 4, 200);
  let key = '';
  try {
    key = idempotencyKey();
  } catch (error) {
    throw new CampusServiceError('LEAVE_INVALID_INPUT', (error as Error).message);
  }
  const keyHash = key ? sha256(key) : null;
  const actorRef = actorRefForStudent(studentId);

  return withTransaction(db, () => {
    const row = get(
      db,
      'SELECT * FROM leave_requests WHERE id = ? AND student_id = ?',
      leaveRequestId,
      studentId,
    );
    if (!row) {
      throw new CampusServiceError('LEAVE_NOT_FOUND', '没有找到这条请假申请', 404);
    }
    const status = String(row.status ?? '');
    if (status === 'cancelled') {
      const prior = get(
        db,
        `SELECT * FROM leave_decisions
         WHERE leave_request_id = ? AND action = 'cancelled'
         ORDER BY created_at DESC LIMIT 1`,
        leaveRequestId,
      );
      if (keyHash && prior && str(prior.idempotency_key_hash) === keyHash) {
        appendEvent(db, {
          action: 'leave.rollback',
          outcome: 'replayed',
          actorRef,
          actorRole: 'student',
          resourceType: 'leave_request',
          resourceId: leaveRequestId,
          details: { idempotencyKeyHash: keyHash },
        });
        return { ok: true, idempotent: true, request: rowToLeaveRequest(db, row) };
      }
      throw new CampusServiceError('LEAVE_ALREADY_CANCELLED', '该申请已撤回', 409);
    }
    if (status === 'rejected_manual' || status === 'evaluating') {
      throw new CampusServiceError(
        'LEAVE_CANCEL_FORBIDDEN',
        status === 'evaluating' ? '申请正在审批中，请稍后重试' : '该申请已有最终结论，不能撤回',
        409,
      );
    }
    const startAt = parseDateTime(row.start_at, '开始时间');
    if (now().getTime() >= startAt.getTime()) {
      throw new CampusServiceError(
        'LEAVE_CANCEL_FORBIDDEN',
        '已超过请假开始时间，不能撤回',
        409,
      );
    }

    const stamp = nowIso();
    appendEvent(db, {
      action: 'leave.rollback',
      outcome: 'attempt',
      actorRef,
      actorRole: 'student',
      resourceType: 'leave_request',
      resourceId: leaveRequestId,
      details: { previousStatus: status, idempotencyKeyHash: keyHash },
    });
    run(
      db,
      `UPDATE leave_requests
       SET status = 'cancelled', decided_at = ?, row_version = row_version + 1, updated_at = ?
       WHERE id = ?`,
      stamp,
      stamp,
      leaveRequestId,
    );
    insertDecision(db, leaveRequestId, {
      action: 'cancelled',
      actorType: 'student',
      actorRef,
      actorName: null,
      reason,
      fromStatus: status,
      toStatus: 'cancelled',
      idempotencyKeyHash: keyHash,
      createdAt: stamp,
    });
    appendEvent(db, {
      action: 'leave.rollback',
      outcome: 'committed',
      actorRef,
      actorRole: 'student',
      resourceType: 'leave_request',
      resourceId: leaveRequestId,
      details: { previousStatus: status, idempotencyKeyHash: keyHash },
    });
    const updated = get(db, 'SELECT * FROM leave_requests WHERE id = ?', leaveRequestId);
    return { ok: true, idempotent: false, request: updated ? rowToLeaveRequest(db, updated) : null };
  });
}

export function verifyAudit(db: DatabaseSync): Record<string, unknown> {
  return verifyChain(db);
}

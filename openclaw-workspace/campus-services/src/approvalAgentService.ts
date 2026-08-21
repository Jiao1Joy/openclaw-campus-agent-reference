/**
 * Private campus-admin Agent approval queue.
 *
 * Student-facing code can only enqueue a leave request. The administrator
 * Agent owns this service and runs the deterministic rule engine through the
 * campus-auto-approval Skill. The model never invents an approval result: the
 * database transition below is the only decision authority.
 */
import type { DatabaseSync } from 'node:sqlite';

import { appendEvent } from './audit.ts';
import { evaluate, loadRuleSnapshot, persistEvaluation, type RuleResult } from './approvalEngine.ts';
import {
  all,
  get,
  nowIso,
  parseDateTime,
  run,
  withTransaction,
  type Row,
} from './db.ts';
import { CampusServiceError } from './errors.ts';
import { autoDecisionSummary, insertDecision, rowToLeaveRequest } from './leaveService.ts';

export interface ApprovalAgentActor {
  ref: string;
  name: string;
}

export const DEFAULT_APPROVAL_AGENT: ApprovalAgentActor = {
  ref: 'agent:campus-admin',
  name: 'OpenClaw 管理员助手',
};

export function listQueuedApprovalJobs(db: DatabaseSync, limit = 10): Record<string, unknown> {
  const bounded = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 10;
  const jobs = all(
    db,
    `SELECT j.id, j.leave_request_id, j.status, j.attempts, j.available_at,
            j.created_at, l.status AS leave_status, l.submitted_at,
            s.student_no, s.name AS student_name
     FROM leave_approval_jobs j
     JOIN leave_requests l ON l.id = j.leave_request_id
     JOIN students s ON s.id = l.student_id
     WHERE j.status IN ('queued','processing') AND l.status = 'evaluating'
     ORDER BY j.available_at, j.created_at
     LIMIT ?`,
    bounded,
  ).map((row) => ({
    id: String(row.id ?? ''),
    leaveRequestId: String(row.leave_request_id ?? ''),
    status: String(row.status ?? ''),
    attempts: Number(row.attempts ?? 0),
    availableAt: String(row.available_at ?? ''),
    submittedAt: String(row.submitted_at ?? ''),
    studentNoMasked: String(row.student_no ?? '').slice(-4).padStart(4, '*'),
    studentName: String(row.student_name ?? ''),
  }));
  return { ok: true, jobs, total: jobs.length };
}

export function approvalJobStatus(db: DatabaseSync, leaveRequestId: string): Record<string, unknown> {
  const row = get(
    db,
    `SELECT j.*, l.status AS leave_status
     FROM leave_approval_jobs j JOIN leave_requests l ON l.id = j.leave_request_id
     WHERE j.leave_request_id = ?`,
    leaveRequestId,
  );
  if (!row) throw new CampusServiceError('APPROVAL_JOB_NOT_FOUND', '未找到管理员审批任务', 404);
  const request = get(db, 'SELECT * FROM leave_requests WHERE id = ?', leaveRequestId) as Row | undefined;
  return {
    ok: true,
    job: {
      id: String(row.id ?? ''),
      leaveRequestId,
      status: String(row.status ?? ''),
      attempts: Number(row.attempts ?? 0),
      resultStatus: row.result_status === null ? null : String(row.result_status),
      lastError: row.last_error === null ? null : String(row.last_error),
    },
    request: request ? rowToLeaveRequest(db, request) : null,
  };
}

export function processApprovalJob(
  db: DatabaseSync,
  leaveRequestId: string,
  actor: ApprovalAgentActor = DEFAULT_APPROVAL_AGENT,
): Record<string, unknown> {
  return withTransaction(db, () => {
    const request = get(db, 'SELECT * FROM leave_requests WHERE id = ?', leaveRequestId) as Row | undefined;
    if (!request) throw new CampusServiceError('LEAVE_NOT_FOUND', '请假申请不存在', 404);
    const job = get(db, 'SELECT * FROM leave_approval_jobs WHERE leave_request_id = ?', leaveRequestId);
    if (!job) throw new CampusServiceError('APPROVAL_JOB_NOT_FOUND', '未找到管理员审批任务', 404);

    if (String(request.status) !== 'evaluating') {
      const stamp = nowIso();
      run(
        db,
        `UPDATE leave_approval_jobs
         SET status = 'completed', completed_at = COALESCE(completed_at, ?),
             result_status = ?, updated_at = ? WHERE leave_request_id = ?`,
        stamp,
        String(request.status),
        stamp,
        leaveRequestId,
      );
      return { ok: true, idempotent: true, request: rowToLeaveRequest(db, request) };
    }

    const stamp = nowIso();
    run(
      db,
      `UPDATE leave_approval_jobs
       SET status = 'processing', attempts = attempts + 1, claimed_at = ?,
           last_error = NULL, updated_at = ? WHERE leave_request_id = ?`,
      stamp,
      stamp,
      leaveRequestId,
    );

    const student = get(db, 'SELECT * FROM students WHERE id = ?', String(request.student_id ?? '')) as Row | undefined;
    if (!student) throw new CampusServiceError('LEAVE_STUDENT_NOT_FOUND', '未找到学生档案', 404);
    const startIso = String(request.start_at ?? '');
    const endIso = String(request.end_at ?? '');
    const submittedIso = String(request.submitted_at ?? '');
    const evaluation = evaluate(db, {
      studentRow: student,
      leaveType: String(request.leave_type ?? ''),
      startIso,
      endIso,
      start: parseDateTime(startIso, '开始时间'),
      end: parseDateTime(endIso, '结束时间'),
      reason: String(request.reason ?? ''),
      submittedAt: parseDateTime(submittedIso, '提交时间'),
      leaveRequestId,
      snapshot: loadRuleSnapshot(db),
    });
    persistEvaluation(db, leaveRequestId, evaluation);

    const keyHash = request.idempotency_key_hash === null ? null : String(request.idempotency_key_hash);
    if (evaluation.outcome === 'approved_auto') {
      const summary = autoDecisionSummary(evaluation);
      run(
        db,
        `UPDATE leave_requests
         SET status = 'approved_auto', decided_at = ?, decision_mode = 'auto',
             decision_reason = ?, rule_version = ?, row_version = row_version + 1,
             updated_at = ? WHERE id = ? AND status = 'evaluating'`,
        stamp,
        summary,
        evaluation.version,
        stamp,
        leaveRequestId,
      );
      insertDecision(db, leaveRequestId, {
        action: 'auto-approve',
        actorType: 'agent',
        actorRef: actor.ref,
        actorName: actor.name,
        reason: summary,
        fromStatus: 'evaluating',
        toStatus: 'approved_auto',
        idempotencyKeyHash: keyHash,
        createdAt: stamp,
      });
    } else {
      const reason =
        evaluation.errorCode ??
        (evaluation.results.find((result) => !result.passed) as RuleResult | undefined)?.message ??
        '转入人工复核';
      run(
        db,
        `UPDATE leave_requests
         SET status = 'manual_review', rule_version = ?, row_version = row_version + 1,
             updated_at = ? WHERE id = ? AND status = 'evaluating'`,
        evaluation.version,
        stamp,
        leaveRequestId,
      );
      insertDecision(db, leaveRequestId, {
        action: 'manual-review',
        actorType: 'agent',
        actorRef: actor.ref,
        actorName: actor.name,
        reason,
        fromStatus: 'evaluating',
        toStatus: 'manual_review',
        idempotencyKeyHash: keyHash,
        createdAt: stamp,
      });
    }

    const updated = get(db, 'SELECT * FROM leave_requests WHERE id = ?', leaveRequestId) as Row;
    const resultStatus = String(updated.status ?? 'manual_review');
    run(
      db,
      `UPDATE leave_approval_jobs
       SET status = 'completed', completed_at = ?, result_status = ?, updated_at = ?
       WHERE leave_request_id = ?`,
      stamp,
      resultStatus,
      stamp,
      leaveRequestId,
    );
    appendEvent(db, {
      action: 'admin-agent.auto-approval',
      outcome: 'committed',
      actorRef: actor.ref,
      actorRole: 'campus-admin-agent',
      resourceType: 'leave_request',
      resourceId: leaveRequestId,
      details: { resultStatus, ruleVersion: evaluation.version, jobId: String(job.id ?? '') },
    });
    return { ok: true, idempotent: false, request: rowToLeaveRequest(db, updated) };
  });
}

export function failApprovalJob(
  db: DatabaseSync,
  leaveRequestId: string,
  errorMessage: string,
  actor: ApprovalAgentActor = DEFAULT_APPROVAL_AGENT,
): Record<string, unknown> {
  return withTransaction(db, () => {
    const request = get(db, 'SELECT * FROM leave_requests WHERE id = ?', leaveRequestId) as Row | undefined;
    if (!request) throw new CampusServiceError('LEAVE_NOT_FOUND', '请假申请不存在', 404);
    if (String(request.status) !== 'evaluating') {
      return { ok: true, idempotent: true, request: rowToLeaveRequest(db, request) };
    }
    const stamp = nowIso();
    const reason = `管理员 Agent 自动审批不可用：${errorMessage.slice(0, 120)}；已保护性转人工复核`;
    run(
      db,
      `UPDATE leave_requests
       SET status = 'manual_review', row_version = row_version + 1, updated_at = ?
       WHERE id = ? AND status = 'evaluating'`,
      stamp,
      leaveRequestId,
    );
    run(
      db,
      `UPDATE leave_approval_jobs
       SET status = 'failed', completed_at = ?, result_status = 'manual_review',
           last_error = ?, updated_at = ? WHERE leave_request_id = ?`,
      stamp,
      errorMessage.slice(0, 500),
      stamp,
      leaveRequestId,
    );
    insertDecision(db, leaveRequestId, {
      action: 'manual-review',
      actorType: 'agent',
      actorRef: actor.ref,
      actorName: actor.name,
      reason,
      fromStatus: 'evaluating',
      toStatus: 'manual_review',
      idempotencyKeyHash: request.idempotency_key_hash === null ? null : String(request.idempotency_key_hash),
      createdAt: stamp,
    });
    appendEvent(db, {
      action: 'admin-agent.auto-approval',
      outcome: 'degraded-to-manual',
      actorRef: actor.ref,
      actorRole: 'campus-admin-agent',
      resourceType: 'leave_request',
      resourceId: leaveRequestId,
      details: { error: errorMessage.slice(0, 120) },
    });
    const updated = get(db, 'SELECT * FROM leave_requests WHERE id = ?', leaveRequestId) as Row;
    return { ok: true, degraded: true, request: rowToLeaveRequest(db, updated) };
  });
}

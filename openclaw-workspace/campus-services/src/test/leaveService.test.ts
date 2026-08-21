/** Leave service tests: state machine, transactional evidence, idempotency. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyChain } from '../audit.ts';
import { listQueuedApprovalJobs, processApprovalJob } from '../approvalAgentService.ts';
import { cancelLeave, createLeave, leaveDetail, listLeaves } from '../leaveService.ts';
import { all, get, withTransaction, type Row } from '../db.ts';
import { CampusServiceError } from '../errors.ts';
import { setupHarness, freezeAt, type Harness } from './helpers.ts';

const harness: Harness = setupHarness();

const AUTO_INPUT = {
  studentId: '202408621',
  studentName: '林同学',
  college: '计算机与人工智能学院',
  className: '软件工程 2401 班',
  leaveType: '病假',
  start: '2026-08-17T14:00:00+08:00',
  end: '2026-08-17T17:00:00+08:00',
  reason: '发烧身体不适前往校医院就诊复查',
};

const MANUAL_INPUT = {
  ...AUTO_INPUT,
  leaveType: '事假',
  start: '2026-08-18T09:00:00+08:00',
  end: '2026-08-19T18:00:00+08:00',
  reason: '家中有急事需要回老家处理相关事务',
};

function create(key: string, input = AUTO_INPUT): Record<string, any> {
  freezeAt('2026-08-17T10:00:00+08:00');
  process.env.CAMPUS_IDEMPOTENCY_KEY = key;
  process.env.CAMPUS_REQUEST_ID = `req-${key}`;
  try {
    const created = createLeave(harness.db, input);
    const requestId = String((created.request as Record<string, unknown>).id || '');
    if (!created.idempotent && String((created.request as Record<string, unknown>).status) === 'evaluating') {
      return { ...created, ...processApprovalJob(harness.db, requestId) };
    }
    return created;
  } finally {
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
    delete process.env.CAMPUS_REQUEST_ID;
  }
}

test('student submission commits evaluating state and a durable admin-agent job', () => {
  freezeAt('2026-08-17T10:00:00+08:00');
  process.env.CAMPUS_IDEMPOTENCY_KEY = 'queue-boundary-0001';
  const created = createLeave(harness.db, {
    ...AUTO_INPUT,
    reason: '学生端只提交数据等待管理员助手处理',
  });
  delete process.env.CAMPUS_IDEMPOTENCY_KEY;
  const request = created.request as Record<string, unknown>;
  assert.equal(request.status, 'evaluating');
  assert.equal(all(harness.db, 'SELECT * FROM leave_rule_evaluations WHERE leave_request_id = ?', String(request.id)).length, 0);
  assert.deepEqual(
    all(harness.db, 'SELECT action FROM leave_decisions WHERE leave_request_id = ?', String(request.id)).map((row) => String(row.action)),
    ['submitted'],
  );
  const jobs = listQueuedApprovalJobs(harness.db, 10).jobs as Array<Record<string, unknown>>;
  assert.ok(jobs.some((job) => job.leaveRequestId === request.id && job.status === 'queued'));
});

test('campus-admin Agent commits evaluation evidence and final decision atomically', () => {
  const result = create('create-auto-0001');
  assert.equal(result.ok, true);
  const request = result.request as Record<string, unknown>;
  assert.equal(request.status, 'approved_auto');
  assert.equal(request.statusLabel, '已自动批准');
  assert.equal(request.decisionMode, 'auto');
  assert.match(String(request.decisionSummary), /全部 9 项低风险规则通过/);
  assert.match(String(request.id), /^LV\d{8}-[A-F0-9]{6}$/);

  const row = get(
    harness.db,
    'SELECT * FROM leave_requests WHERE id = ?',
    String(request.id),
  ) as Row;
  assert.equal(String(row.status), 'approved_auto');
  assert.equal(Number(row.rule_version), 1);

  const evaluations = all(
    harness.db,
    'SELECT * FROM leave_rule_evaluations WHERE leave_request_id = ?',
    String(request.id),
  );
  assert.equal(evaluations.length, 1);
  const results = all(
    harness.db,
    'SELECT * FROM leave_rule_results WHERE evaluation_id = ? ORDER BY sequence',
    String(evaluations[0]?.id),
  );
  assert.equal(results.length, 9);
  assert.ok(results.every((item) => Number(item.passed) === 1));

  const decisions = all(
    harness.db,
    'SELECT * FROM leave_decisions WHERE leave_request_id = ? ORDER BY created_at',
    String(request.id),
  );
  assert.deepEqual(
    decisions.map((item) => String(item.action)),
    ['submitted', 'auto-approve'],
  );
  assert.equal(String(decisions[1]?.actor_type), 'agent');
  assert.equal(String(decisions[1]?.actor_ref), 'agent:campus-admin');
});

test('failed rules send the request to manual_review with visible reasons', () => {
  const result = create('create-manual-0001', MANUAL_INPUT);
  const request = result.request as Record<string, unknown>;
  assert.equal(request.status, 'manual_review');
  assert.equal(request.statusLabel, '待人工复核');
  const failed = request.failedRules as Array<{ ruleCode: string }>;
  assert.ok(failed.some((item) => item.ruleCode === 'SAME_DAY'));
  assert.equal(request.decisionMode, null);
});

test('same idempotency key replays the original result', () => {
  const first = create('replay-key-0001');
  const second = create('replay-key-0001');
  assert.equal(second.idempotent, true);
  assert.equal(second.duplicate, true);
  assert.equal(
    (second.request as Record<string, unknown>).id,
    (first.request as Record<string, unknown>).id,
  );
});

test('same idempotency key with different content is rejected', () => {
  create('conflict-key-0001');
  freezeAt('2026-08-17T10:00:00+08:00');
  process.env.CAMPUS_IDEMPOTENCY_KEY = 'conflict-key-0001';
  try {
    assert.throws(
      () =>
        createLeave(harness.db, {
          ...AUTO_INPUT,
          reason: '另外一个完全不同的请假原因说明',
        }),
      (error: unknown) =>
        error instanceof CampusServiceError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
  }
});

test('identical content without a key returns the existing record as duplicate', () => {
  const first = createLeave(harness.db, AUTO_INPUT);
  freezeAt('2026-08-17T10:00:00+08:00');
  const second = createLeave(harness.db, AUTO_INPUT);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(
    (second.request as Record<string, unknown>).id,
    (first.request as Record<string, unknown>).id,
  );
});

test('unknown student is a business error, not a silent auto-approve', () => {
  freezeAt('2026-08-17T10:00:00+08:00');
  assert.throws(
    () =>
      createLeave(harness.db, {
        ...AUTO_INPUT,
        studentId: '999999999',
        reason: '发烧身体不适前往校医院就诊复查',
      }),
    (error: unknown) =>
      error instanceof CampusServiceError && error.code === 'LEAVE_STUDENT_NOT_FOUND',
  );
});

test('cancel: pending before start ok, after start forbidden, replay idempotent', () => {
  const created = create('cancel-flow-0001', MANUAL_INPUT);
  const id = String((created.request as Record<string, unknown>).id);

  freezeAt('2026-08-17T11:00:00+08:00');
  process.env.CAMPUS_IDEMPOTENCY_KEY = 'cancel-key-0001';
  process.env.CAMPUS_REQUEST_ID = 'req-cancel-1';
  let cancelled: Record<string, unknown>;
  try {
    cancelled = cancelLeave(harness.db, '202408621', id, '计划有变不需要请假了');
  } finally {
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
    delete process.env.CAMPUS_REQUEST_ID;
  }
  assert.equal((cancelled.request as Record<string, unknown>).status, 'cancelled');

  process.env.CAMPUS_IDEMPOTENCY_KEY = 'cancel-key-0001';
  try {
    const replay = cancelLeave(harness.db, '202408621', id, '计划有变不需要请假了');
    assert.equal(replay.idempotent, true);
  } finally {
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
  }

  const second = create('cancel-flow-0002', {
    ...MANUAL_INPUT,
    start: '2026-08-18T09:30:00+08:00',
    end: '2026-08-18T12:30:00+08:00',
    reason: '上午需要外出办理银行业务手续',
  });
  const secondId = String((second.request as Record<string, unknown>).id);
  freezeAt('2026-08-18T10:00:00+08:00'); // after start
  assert.throws(
    () => cancelLeave(harness.db, '202408621', secondId, '想要撤回这条申请'),
    (error: unknown) =>
      error instanceof CampusServiceError && error.code === 'LEAVE_CANCEL_FORBIDDEN',
  );
});

test('list and detail expose the full timeline and rule evidence', () => {
  const created = create('detail-flow-0001');
  const id = String((created.request as Record<string, unknown>).id);

  const listed = listLeaves(harness.db, '202408621', 10);
  assert.equal(listed.total, 1);
  const item = (listed.requests as Array<Record<string, unknown>>)[0];
  assert.ok(item);
  assert.equal(item.studentId, '202408621');
  assert.equal(item.studentName, '林同学');
  assert.equal(item.college, '计算机与人工智能学院');

  const detail = leaveDetail(harness.db, '202408621', id);
  const ruleResults = detail.ruleResults as Array<{ ruleCode: string; passed: boolean }>;
  assert.equal(ruleResults.length, 9);
  const timeline = detail.timeline as Array<{ action: string }>;
  assert.deepEqual(
    timeline.map((entry) => entry.action),
    ['submitted', 'auto-approve'],
  );
  assert.equal(detail.studentHistoryCount, 1);

  assert.throws(
    () => leaveDetail(harness.db, '999999999', id),
    (error: unknown) => error instanceof CampusServiceError && error.code === 'LEAVE_FORBIDDEN',
  );
});

test('audit hash chain verifies and detects tampering', () => {
  create('audit-flow-0001');
  const verified = verifyChain(harness.db);
  assert.equal(verified.ok, true);
  assert.ok(verified.events >= 2);

  withTransaction(harness.db, () => {
    harness.db.exec("UPDATE audit_events SET hash = '0'||substr(hash,2) WHERE sequence = 2");
  });
  const tampered = verifyChain(harness.db);
  assert.equal(tampered.ok, false);
});

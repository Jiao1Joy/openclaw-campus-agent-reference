/** Admin service tests: approve/reject semantics, concurrency, rules, reset. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adminApprove,
  adminBatchApprove,
  adminDashboard,
  adminListLeaves,
  adminReject,
  demoReset,
  rulesGet,
  rulesPut,
  DEMO_RESET_PHRASE,
  type AdminActor,
} from '../adminService.ts';
import { createLeave } from '../leaveService.ts';
import { processApprovalJob } from '../approvalAgentService.ts';
import { get, run, type Row } from '../db.ts';
import { CampusServiceError } from '../errors.ts';
import { setupHarness, freezeAt, type Harness } from './helpers.ts';

const harness: Harness = setupHarness();

const ADMIN: AdminActor = { ref: 'admin-test', name: '测试管理员' };
const MANUAL_INPUT = {
  studentId: '202408621',
  studentName: '林同学',
  college: '计算机与人工智能学院',
  className: '软件工程 2401 班',
  leaveType: '公假',
  start: '2026-08-20T09:00:00+08:00',
  end: '2026-08-20T12:00:00+08:00',
  reason: '参加省级程序设计竞赛联合集训活动',
};

function createManual(key: string): string {
  freezeAt('2026-08-17T10:00:00+08:00');
  process.env.CAMPUS_IDEMPOTENCY_KEY = key;
  try {
    const unique = key.slice(-4).replace(/\D/g, '') || '0';
    const day = 20 + (Number(unique) % 8);
    const result = createLeave(harness.db, {
      ...MANUAL_INPUT,
      start: `2026-08-${String(day).padStart(2, '0')}T09:00:00+08:00`,
      end: `2026-08-${String(day).padStart(2, '0')}T12:00:00+08:00`,
      reason: `参加省级程序设计竞赛联合集训活动第${key}批`,
    });
    const id = String((result.request as Record<string, unknown>).id);
    processApprovalJob(harness.db, id);
    return id;
  } finally {
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
  }
}

test('approve transitions manual_review -> approved_manual and records evidence', () => {
  const id = createManual('adm-approve-0001');
  const result = adminApprove(harness.db, ADMIN, id, { reason: '情况属实' });
  const request = result.request as Record<string, unknown>;
  assert.equal(request.status, 'approved_manual');
  assert.equal(request.decisionMode, 'manual');
  assert.equal(request.decisionSummary, '已人工批准：情况属实');

  const decision = get(
    harness.db,
    "SELECT * FROM leave_decisions WHERE leave_request_id = ? AND action = 'manual-approve'",
    id,
  ) as Row;
  assert.equal(String(decision.actor_type), 'admin');
  assert.equal(String(decision.actor_name), '测试管理员');
});

test('repeated approvals conflict with LEAVE_ALREADY_DECIDED (409)', () => {
  const id = createManual('adm-twice-0001');
  adminApprove(harness.db, ADMIN, id, {});
  assert.throws(
    () => adminApprove(harness.db, ADMIN, id, {}),
    (error: unknown) => {
      assert.ok(error instanceof CampusServiceError);
      assert.equal(error.code, 'LEAVE_ALREADY_DECIDED');
      assert.equal(error.httpStatus, 409);
      return true;
    },
  );
});

test('stale row_version conflicts (optimistic concurrency)', () => {
  const id = createManual('adm-stale-0001');
  const row = get(harness.db, 'SELECT row_version FROM leave_requests WHERE id = ?', id) as Row;
  const staleVersion = Number(row.row_version) - 1;
  assert.throws(
    () => adminApprove(harness.db, ADMIN, id, { rowVersion: staleVersion }),
    (error: unknown) =>
      error instanceof CampusServiceError && error.code === 'LEAVE_ALREADY_DECIDED',
  );
});

test('two concurrent approvers: only one succeeds (busy_timeout serialized)', () => {
  const id = createManual('adm-race-0001');
  const row = get(harness.db, 'SELECT row_version FROM leave_requests WHERE id = ?', id) as Row;
  const rowVersion = Number(row.row_version);
  const first = adminApprove(harness.db, ADMIN, id, { rowVersion });
  assert.equal((first.request as Record<string, unknown>).status, 'approved_manual');
  assert.throws(
    () => adminApprove(harness.db, { ...ADMIN, ref: 'admin-second' }, id, { rowVersion }),
    (error: unknown) =>
      error instanceof CampusServiceError && error.code === 'LEAVE_ALREADY_DECIDED',
  );
});

test('approve idempotency: same admin key replays the stored outcome', () => {
  const id = createManual('adm-idem-0001');
  const actor: AdminActor = { ...ADMIN, idempotencyKey: 'admin-key-0001' };
  const first = adminApprove(harness.db, actor, id, {});
  const replay = adminApprove(harness.db, actor, id, {});
  assert.equal(first.idempotent, false);
  assert.equal(replay.idempotent, true);
  assert.equal(
    (replay.request as Record<string, unknown>).id,
    (first.request as Record<string, unknown>).id,
  );
});

test('reject requires a 4-200 char reason and stores it verbatim', () => {
  const id = createManual('adm-reject-0001');
  assert.throws(
    () => adminReject(harness.db, ADMIN, id, { reason: '太短' }),
    (error: unknown) => error instanceof CampusServiceError && error.code === 'LEAVE_INVALID_INPUT',
  );
  const result = adminReject(harness.db, ADMIN, id, {
    reason: '证明材料不足，请补充后重新申请',
  });
  const request = result.request as Record<string, unknown>;
  assert.equal(request.status, 'rejected_manual');
  assert.equal(request.decisionSummary, '证明材料不足，请补充后重新申请');
});

test('batch approve handles mixed states per item and caps at 50', () => {
  const approved = createManual('batch-approve-0001');
  adminApprove(harness.db, ADMIN, approved, {});
  const pending1 = createManual('batch-approve-0002');
  const pending2 = createManual('batch-approve-0003');
  const result = adminBatchApprove(harness.db, ADMIN, [approved, pending1, pending2]);
  assert.equal(result.total, 3);
  assert.equal(result.approved, 2);
  assert.equal(result.skipped, 1);
  const results = result.results as Array<{ id: string; ok: boolean; code?: string }>;
  const skippedItem = results.find((item) => !item.ok);
  assert.equal(skippedItem?.code, 'LEAVE_ALREADY_DECIDED');

  assert.throws(
    () => adminBatchApprove(harness.db, ADMIN, Array.from({ length: 51 }, (_, i) => `LV${i}`)),
    (error: unknown) => error instanceof CampusServiceError && error.code === 'BATCH_TOO_LARGE',
  );
});

test('batch approve approves every item and replays per item idempotently', () => {
  const first = createManual('batch-multi-0001');
  const second = createManual('batch-multi-0002');
  const third = createManual('batch-multi-0003');
  const actor: AdminActor = { ...ADMIN, idempotencyKey: 'batch-key-multi-0001' };

  const result = adminBatchApprove(harness.db, actor, [first, second, third]);
  assert.equal(result.approved, 3);
  assert.equal(result.skipped, 0);
  const items = result.results as Array<{ id: string; ok: boolean; status: string }>;
  assert.ok(items.every((item) => item.ok));
  // regression guard: every leave must actually be decided, not replayed
  for (const id of [first, second, third]) {
    const row = get(harness.db, 'SELECT status FROM leave_requests WHERE id = ?', id) as Row;
    assert.equal(String(row.status), 'approved_manual', id);
  }
  const decisions = get(
    harness.db,
    "SELECT COUNT(*) AS total FROM leave_decisions WHERE action = 'manual-approve'",
  ) as Row;
  assert.equal(Number(decisions.total), 3);

  const replay = adminBatchApprove(harness.db, actor, [first, second, third]);
  assert.equal(replay.approved, 3);
  const replayItems = replay.results as Array<{ id: string; idempotent: boolean }>;
  assert.ok(replayItems.every((item) => item.idempotent));
  const decisionsAfterReplay = get(
    harness.db,
    "SELECT COUNT(*) AS total FROM leave_decisions WHERE action = 'manual-approve'",
  ) as Row;
  assert.equal(Number(decisionsAfterReplay.total), 3);
});

test('dashboard aggregates metrics and 7-day trend', () => {
  createManual('dash-0001');
  createManual('dash-0002');
  const dashboard = adminDashboard(harness.db);
  const metrics = dashboard.metrics as Record<string, number | null>;
  assert.equal(metrics.pendingManual, 2);
  assert.equal(metrics.todaySubmitted, 2);
  assert.equal(metrics.totalRequests, 2);
  const trend = dashboard.trend as Array<{ date: string; submitted: number }>;
  assert.equal(trend.length, 7);
  assert.equal(trend[6]?.submitted, 2);
});

test('rule updates re-version globally and take effect immediately', () => {
  const versionBefore = (rulesGet(harness.db).version as number) ?? 0;
  const updated = rulesPut(harness.db, ADMIN, [
    { ruleCode: 'SAME_DAY', enabled: false },
    { ruleCode: 'DURATION_LIMIT', config: { maxMinutes: 720 } },
  ]);
  assert.equal(updated.version, versionBefore + 1);

  freezeAt('2026-08-17T10:00:00+08:00');
  process.env.CAMPUS_IDEMPOTENCY_KEY = 'rules-effect-0001';
  let outcome: Record<string, unknown>;
  try {
    outcome = createLeave(harness.db, {
      ...MANUAL_INPUT,
      leaveType: '病假',
      start: '2026-08-18T09:00:00+08:00',
      end: '2026-08-18T20:00:00+08:00', // cross-day now allowed, 11h within 12h cap
      reason: '肠胃炎需要全天休养观察身体情况',
    });
  } finally {
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
  }
  const request = outcome.request as Record<string, unknown>;
  const processed = processApprovalJob(harness.db, String(request.id));
  const approved = processed.request as Record<string, unknown>;
  assert.equal(approved.status, 'approved_auto');
  const ruleSummary = approved.ruleSummary as { version: number } | null;
  assert.equal(ruleSummary?.version, versionBefore + 1);

  assert.throws(
    () => rulesPut(harness.db, ADMIN, [{ ruleCode: 'NOT_A_RULE', enabled: false }]),
    (error: unknown) => error instanceof Error && /未知规则/.test(error.message),
  );
});

test('demo reset requires the confirmation phrase and restores baseline', () => {
  createManual('reset-0001');
  assert.throws(
    () => demoReset(harness.db, ADMIN, 'wrong-phrase'),
    (error: unknown) =>
      error instanceof CampusServiceError && error.code === 'DEMO_RESET_CONFIRMATION_REQUIRED',
  );
  const result = demoReset(harness.db, ADMIN, DEMO_RESET_PHRASE);
  assert.equal(result.reset, true);
  const leaves = get(harness.db, 'SELECT COUNT(*) AS total FROM leave_requests') as Row;
  assert.equal(Number(leaves.total), 0);
  const students = get(harness.db, 'SELECT COUNT(*) AS total FROM students') as Row;
  assert.equal(Number(students.total), 1);
  const rules = rulesGet(harness.db);
  assert.equal(Object.keys(rules.rules as object).length, 9);
});

test('admin list filters by status / college and paginates', () => {
  createManual('list-0001');
  createManual('list-0002');
  const pending = adminListLeaves(harness.db, { status: 'manual_review', pageSize: 1, page: 2 });
  assert.equal(pending.total, 2);
  assert.equal((pending.items as unknown[]).length, 1);
  const byCollege = adminListLeaves(harness.db, { collegeId: 'COLLEGE-CSAI' });
  assert.equal(byCollege.total, 2);
  run(harness.db, "UPDATE students SET status = 'suspended' WHERE student_no = '202408621'");
  const none = adminListLeaves(harness.db, { keyword: '不存在的关键字' });
  assert.equal(none.total, 0);
});

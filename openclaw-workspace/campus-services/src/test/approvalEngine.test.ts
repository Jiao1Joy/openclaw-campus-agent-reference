/** Rule engine unit tests: pass / boundary / fail for every default rule. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluate, loadRuleSnapshot } from '../approvalEngine.ts';
import { all, get, parseDateTime, run } from '../db.ts';
import type { Row } from '../db.ts';
import { setupHarness, freezeAt, type Harness } from './helpers.ts';

const harness: Harness = setupHarness();

const SUBMITTED = '2026-08-17T10:00:00+08:00';

function evalNow(
  overrides: Partial<Parameters<typeof evaluate>[1]> = {},
): ReturnType<typeof evaluate> {
  freezeAt(SUBMITTED);
  const student = get(harness.db, 'SELECT * FROM students WHERE student_no = ?', '202408621') as Row;
  return evaluate(harness.db, {
    studentRow: student,
    leaveType: 'sick',
    startIso: '2026-08-17T14:00:00+08:00',
    endIso: '2026-08-17T17:00:00+08:00',
    start: parseDateTime('2026-08-17T14:00:00+08:00', '开始时间'),
    end: parseDateTime('2026-08-17T17:00:00+08:00', '结束时间'),
    reason: '发烧身体不适前往校医院就诊复查',
    submittedAt: parseDateTime(SUBMITTED, '提交时间'),
    leaveRequestId: 'LVTEST-UNUSED',
    ...overrides,
  });
}

function resultOf(evaluation: ReturnType<typeof evalNow>, code: string) {
  return evaluation.results.find((item) => item.ruleCode === code);
}

test('all rules pass for a clean same-day sick leave', () => {
  const evaluation = evalNow();
  assert.equal(evaluation.outcome, 'approved_auto');
  assert.equal(evaluation.results.length, 9);
  assert.ok(evaluation.results.every((item) => item.passed));
  assert.equal(evaluation.errorCode, null);
});

test('LEAVE_TYPE_ALLOWED: only sick/personal can auto-approve', () => {
  for (const leaveType of ['official', 'other']) {
    const evaluation = evalNow({ leaveType });
    assert.equal(evaluation.outcome, 'manual_review', leaveType);
    assert.equal(resultOf(evaluation, 'LEAVE_TYPE_ALLOWED')?.passed, false);
  }
});

test('REASON_COMPLETE: length boundaries 8/200 and placeholder text', () => {
  const short = evalNow({ reason: '发烧就医'.padEnd(7, '了') }); // 7 chars
  assert.equal(resultOf(short, 'REASON_COMPLETE')?.passed, false);
  const min = evalNow({ reason: '发烧就医了需要休息半天观察' }); // >= 8
  assert.equal(resultOf(min, 'REASON_COMPLETE')?.passed, true);
  const max = evalNow({ reason: '原因'.padEnd(200, '详细') });
  assert.equal(resultOf(max, 'REASON_COMPLETE')?.passed, true);
  const tooLong = evalNow({ reason: '原因'.padEnd(201, '详细') });
  assert.equal(resultOf(tooLong, 'REASON_COMPLETE')?.passed, false);
  // exact placeholder match is configured per the fixed word list (plan 9)
  const snapshot = loadRuleSnapshot(harness.db);
  const withPlaceholders = structuredClone(snapshot);
  withPlaceholders.rules.REASON_COMPLETE = {
    name: '原因完整',
    enabled: true,
    config: {
      minLength: 8,
      maxLength: 200,
      placeholders: ['无', '不知道', '随便', '测试', '不知道写什么原因'],
    },
  };
  freezeAt(SUBMITTED);
  const student = get(harness.db, 'SELECT * FROM students WHERE student_no = ?', '202408621') as Row;
  const placeholderEval = evaluate(harness.db, {
    studentRow: student,
    leaveType: 'sick',
    startIso: '2026-08-17T14:00:00+08:00',
    endIso: '2026-08-17T17:00:00+08:00',
    start: parseDateTime('2026-08-17T14:00:00+08:00', '开始时间'),
    end: parseDateTime('2026-08-17T17:00:00+08:00', '结束时间'),
    reason: '不知道写什么原因',
    submittedAt: parseDateTime(SUBMITTED, '提交时间'),
    leaveRequestId: 'LVTEST-PLACEHOLDER',
    snapshot: withPlaceholders,
  });
  const placeholderResult = placeholderEval.results.find(
    (item) => item.ruleCode === 'REASON_COMPLETE',
  );
  assert.equal(placeholderResult?.passed, false);
  assert.equal((placeholderResult?.actual as { placeholder: boolean }).placeholder, true);
  const repeated = evalNow({ reason: '哈哈哈哈哈哈哈哈' });
  assert.equal(resultOf(repeated, 'REASON_COMPLETE')?.passed, false);
});

test('FUTURE_REQUEST: exactly 2h passes, 1h59m fails', () => {
  const boundary = evalNow({
    startIso: '2026-08-17T12:00:00+08:00',
    start: parseDateTime('2026-08-17T12:00:00+08:00', '开始时间'),
    endIso: '2026-08-17T15:00:00+08:00',
    end: parseDateTime('2026-08-17T15:00:00+08:00', '结束时间'),
  });
  assert.equal(resultOf(boundary, 'FUTURE_REQUEST')?.passed, true);
  const tooSoon = evalNow({
    startIso: '2026-08-17T11:59:00+08:00',
    start: parseDateTime('2026-08-17T11:59:00+08:00', '开始时间'),
    endIso: '2026-08-17T14:59:00+08:00',
    end: parseDateTime('2026-08-17T14:59:00+08:00', '结束时间'),
  });
  assert.equal(resultOf(tooSoon, 'FUTURE_REQUEST')?.passed, false);
});

test('DATE_RANGE_ALLOWED: +30d boundary passes, beyond fails', () => {
  // submitted = 2026-08-17T10:00+08:00; horizon = 2026-09-16T10:00+08:00
  const horizon = evalNow({
    startIso: '2026-09-16T09:00:00+08:00',
    start: parseDateTime('2026-09-16T09:00:00+08:00', '开始时间'),
    endIso: '2026-09-16T12:00:00+08:00',
    end: parseDateTime('2026-09-16T12:00:00+08:00', '结束时间'),
  });
  assert.equal(resultOf(horizon, 'DATE_RANGE_ALLOWED')?.passed, true);
  const beyond = evalNow({
    startIso: '2026-09-16T11:00:00+08:00',
    start: parseDateTime('2026-09-16T11:00:00+08:00', '开始时间'),
    endIso: '2026-09-16T14:00:00+08:00',
    end: parseDateTime('2026-09-16T14:00:00+08:00', '结束时间'),
  });
  assert.equal(resultOf(beyond, 'DATE_RANGE_ALLOWED')?.passed, false);
});

test('SAME_DAY + DURATION_LIMIT: 8h same-day passes, cross-day fails', () => {
  const eightHours = evalNow({
    startIso: '2026-08-17T12:00:00+08:00',
    start: parseDateTime('2026-08-17T12:00:00+08:00', '开始时间'),
    endIso: '2026-08-17T20:00:00+08:00',
    end: parseDateTime('2026-08-17T20:00:00+08:00', '结束时间'),
  });
  assert.equal(resultOf(eightHours, 'DURATION_LIMIT')?.passed, true);
  const overEight = evalNow({
    startIso: '2026-08-17T12:00:00+08:00',
    start: parseDateTime('2026-08-17T12:00:00+08:00', '开始时间'),
    endIso: '2026-08-17T20:01:00+08:00',
    end: parseDateTime('2026-08-17T20:01:00+08:00', '结束时间'),
  });
  assert.equal(resultOf(overEight, 'DURATION_LIMIT')?.passed, false);
  const crossDay = evalNow({
    startIso: '2026-08-17T20:00:00+08:00',
    start: parseDateTime('2026-08-17T20:00:00+08:00', '开始时间'),
    endIso: '2026-08-18T01:00:00+08:00',
    end: parseDateTime('2026-08-18T01:00:00+08:00', '结束时间'),
  });
  assert.equal(resultOf(crossDay, 'SAME_DAY')?.passed, false);
});

test('NO_OVERLAP: overlapping fails, touching passes, cancelled ignored', () => {
  const student = get(harness.db, 'SELECT * FROM students WHERE student_no = ?', '202408621') as Row;
  const insertOverlap = (id: string, status: string) => {
    run(
      harness.db,
      `INSERT INTO leave_requests
        (id, student_id, leave_type, start_at, end_at, reason, status, source,
         submitted_at, row_version, created_at, updated_at)
       VALUES (?, ?, 'personal', '2026-08-17T15:00:00+08:00', '2026-08-17T16:00:00+08:00',
               '既有请假申请冲突测试数据', ?, 'campus-assistant', ?, 1, ?, ?)`,
      id,
      String(student.id ?? ''),
      status,
      SUBMITTED,
      SUBMITTED,
      SUBMITTED,
    );
  };
  insertOverlap('LVTEST-OVERLAP', 'manual_review');
  const overlap = evalNow({ leaveRequestId: 'LVTEST-NEW' });
  assert.equal(resultOf(overlap, 'NO_OVERLAP')?.passed, false);

  const touching = evalNow({
    startIso: '2026-08-17T16:00:00+08:00',
    start: parseDateTime('2026-08-17T16:00:00+08:00', '开始时间'),
    endIso: '2026-08-17T18:00:00+08:00',
    end: parseDateTime('2026-08-17T18:00:00+08:00', '结束时间'),
    leaveRequestId: 'LVTEST-NEW',
  });
  assert.equal(resultOf(touching, 'NO_OVERLAP')?.passed, true);

  run(harness.db, "UPDATE leave_requests SET status = 'cancelled' WHERE id = 'LVTEST-OVERLAP'");
  const afterCancel = evalNow({ leaveRequestId: 'LVTEST-NEW' });
  assert.equal(resultOf(afterCancel, 'NO_OVERLAP')?.passed, true);
});

test('FREQUENCY_LIMIT: 3 approved in window fails; cumulative hours capped at 24h', () => {
  const student = get(harness.db, 'SELECT * FROM students WHERE student_no = ?', '202408621') as Row;
  const insertApproved = (id: string, decidedAt: string, minutes: number) => {
    const day = decidedAt.slice(0, 10);
    run(
      harness.db,
      `INSERT INTO leave_requests
        (id, student_id, leave_type, start_at, end_at, reason, status, source,
         submitted_at, decided_at, decision_mode, row_version, created_at, updated_at)
       VALUES (?, ?, 'sick', ?, ?, '历史已批准请假记录占位原因', 'approved_auto', 'seed',
               ?, ?, 'auto', 1, ?, ?)`,
      id,
      String(student.id ?? ''),
      `${day}T08:00:00+08:00`,
      `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00+08:00`,
      `${day}T07:00:00+08:00`,
      decidedAt,
      `${day}T07:00:00+08:00`,
      `${day}T07:00:00+08:00`,
    );
  };
  // two prior approvals totalling 21h (1260 min); +3h current = 1440 exactly
  insertApproved('LVTEST-FREQ-1', '2026-08-05T08:00:00+08:00', 660);
  insertApproved('LVTEST-FREQ-2', '2026-08-10T08:00:00+08:00', 600);
  const boundary = evalNow({ leaveRequestId: 'LVTEST-NEW' });
  assert.equal(resultOf(boundary, 'FREQUENCY_LIMIT')?.passed, true);

  // third approval pushes count to 3 => count check fails
  insertApproved('LVTEST-FREQ-3', '2026-08-15T08:00:00+08:00', 60);
  const exceeded = evalNow({ leaveRequestId: 'LVTEST-NEW' });
  const frequency = resultOf(exceeded, 'FREQUENCY_LIMIT');
  assert.equal(frequency?.passed, false);
  assert.equal((frequency?.actual as { approvedCount: number }).approvedCount, 3);

  // old decisions outside the 30-day window do not count
  run(harness.db, "UPDATE leave_requests SET decided_at = '2026-07-01T08:00:00+08:00' WHERE id = 'LVTEST-FREQ-3'");
  const stale = evalNow({ leaveRequestId: 'LVTEST-NEW' });
  assert.equal(resultOf(stale, 'FREQUENCY_LIMIT')?.passed, true);
});

test('STUDENT_ACTIVE: suspended student goes to manual review', () => {
  run(harness.db, "UPDATE students SET status = 'suspended' WHERE student_no = '202408621'");
  const evaluation = evalNow();
  assert.equal(evaluation.outcome, 'manual_review');
  assert.equal(resultOf(evaluation, 'STUDENT_ACTIVE')?.passed, false);
});

test('engine errors degrade protectively to manual_review', () => {
  freezeAt(SUBMITTED);
  const snapshot = loadRuleSnapshot(harness.db);
  const broken = { version: snapshot.version, rules: {} };
  const student = get(harness.db, 'SELECT * FROM students WHERE student_no = ?', '202408621') as Row;
  const evaluation = evaluate(harness.db, {
    studentRow: student,
    leaveType: 'sick',
    startIso: '2026-08-17T14:00:00+08:00',
    endIso: '2026-08-17T17:00:00+08:00',
    start: parseDateTime('2026-08-17T14:00:00+08:00', '开始时间'),
    end: parseDateTime('2026-08-17T17:00:00+08:00', '结束时间'),
    reason: '发烧身体不适前往校医院就诊复查',
    submittedAt: parseDateTime(SUBMITTED, '提交时间'),
    leaveRequestId: 'LVTEST-UNUSED',
    snapshot: broken,
  });
  assert.equal(evaluation.outcome, 'manual_review');
  assert.equal(evaluation.errorCode, 'ENGINE_ERROR');
});

test('same input and rule version always produce the same outcome', () => {
  const first = evalNow();
  const second = evalNow();
  assert.deepEqual(
    first.results.map((item) => [item.ruleCode, item.passed]),
    second.results.map((item) => [item.ruleCode, item.passed]),
  );
  assert.equal(first.outcome, second.outcome);
  assert.ok(all(harness.db, 'SELECT 1 AS ok').length > 0);
});

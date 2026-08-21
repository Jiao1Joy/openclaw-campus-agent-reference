/** Seed generation + import + closed approval loop (plan sections 13/16-IV). */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { generateSeedIntoDb, writeSeedFiles } from '../bin/generateSeed.ts';
import { importDemoSeed } from '../bin/importDemoSeed.ts';
import { adminApprove } from '../adminService.ts';
import { processApprovalJob } from '../approvalAgentService.ts';
import { cancelLeave, createLeave, listLeaves } from '../leaveService.ts';
import { openDatabase, withTransaction } from '../db.ts';
import { seedDemoBase } from '../seed.ts';
import { setupHarness, type Harness } from './helpers.ts';

const harness: Harness = setupHarness();

test('seed generator meets the plan quotas with engine-consistent statuses', () => {
  const db = openDatabase(':memory:');
  try {
    const result = generateSeedIntoDb(db);
    const { quotas, leaves } = result;
    assert.equal(quotas.leaves, 600);
    // per-status targets hold within a small retry tolerance
    assert.ok(quotas.auto >= 205, `auto ${quotas.auto}`);
    assert.ok(quotas.manual >= 145, `manual ${quotas.manual}`);
    assert.ok(quotas.approvedManual >= 115, `approvedManual ${quotas.approvedManual}`);
    assert.ok(quotas.rejected >= 55, `rejected ${quotas.rejected}`);
    assert.ok(quotas.cancelled >= 55, `cancelled ${quotas.cancelled}`);
    assert.ok(quotas.shortLead >= 50, `shortLead ${quotas.shortLead}`);
    assert.ok(quotas.overlapPairs >= 45, `overlapPairs ${quotas.overlapPairs}`);
    assert.ok(quotas.busyStudents >= 40, `busyStudents ${quotas.busyStudents}`);
    assert.ok(quotas.placeholderReasons >= 4, `placeholders ${quotas.placeholderReasons}`);
    // structure
    assert.equal(result.structure.colleges.length, 6);
    assert.equal(result.structure.classes.length, 24);
    assert.equal(result.structure.students.length, 480);
    const types = new Map<string, number>();
    for (const record of leaves) types.set(record.leaveType, (types.get(record.leaveType) ?? 0) + 1);
    assert.ok((types.get('sick') ?? 0) >= 250, `sick ${types.get('sick')}`);
    assert.ok((types.get('personal') ?? 0) >= 195, `personal ${types.get('personal')}`);
    // auto samples only use sick/personal and same-day <=8h with >=2h lead
    for (const record of leaves.filter((item) => item.status === 'approved_auto')) {
      assert.ok(['sick', 'personal'].includes(record.leaveType), record.id);
      assert.equal(record.startAt.slice(0, 10), record.endAt.slice(0, 10), record.id);
      const minutes =
        (new Date(record.endAt).getTime() - new Date(record.startAt).getTime()) / 60_000;
      assert.ok(minutes > 0 && minutes <= 480, record.id);
      const lead = (new Date(record.startAt).getTime() - new Date(record.submittedAt).getTime()) / 60_000;
      assert.ok(lead >= 120, record.id);
    }
    // rejected records carry 4-200 char human reasons
    for (const record of leaves.filter((item) => item.status === 'rejected_manual')) {
      assert.ok(
        record.decisionReason && record.decisionReason.length >= 4 && record.decisionReason.length <= 200,
        record.id,
      );
    }
    // all timestamps ISO 8601 with +08:00
    for (const record of leaves.slice(0, 30)) {
      assert.match(record.startAt, /\+08:00$/);
      assert.match(record.submittedAt, /\+08:00$/);
    }
    // determinism: same seed regenerates identical output
    const db2 = openDatabase(':memory:');
    try {
      const again = generateSeedIntoDb(db2);
      assert.deepEqual(again.leaves, leaves);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});

test('generated seed imports cleanly into a fresh database', () => {
  const generateDb = openDatabase(':memory:');
  let seedDir = '';
  try {
    const result = generateSeedIntoDb(generateDb);
    seedDir = mkdtempSync(join(tmpdir(), 'campus-seed-'));
    writeSeedFiles(seedDir, result);
  } finally {
    generateDb.close();
  }

  const db = openDatabase(join(harness.dbPath, '..', 'seed-import.sqlite3'));
  try {
    withTransaction(db, () => seedDemoBase(db));
    const imported = importDemoSeed(db, seedDir) as Record<string, unknown>;
    assert.equal(imported.ok, true);
    assert.equal(imported.importedLeaves, 600);
    // the seed's COLLEGE-CSAI shares its id with the demo baseline college
    // (same name) and replaces it; the baseline class/student are retained
    assert.equal(imported.colleges, 6);
    assert.equal(imported.classes, 25);
    assert.equal(imported.students, 481);

    // every seed record keeps its rule evaluation and a decision timeline,
    // including human decisions (regression: admin detail used to show
    // "migrated legacy data" with an empty timeline for approved_manual)
    const sample = db
      .prepare(
        `SELECT l.id, l.status FROM leave_requests l
         JOIN students s ON s.id = l.student_id
         WHERE l.source = 'seed' AND l.status = 'approved_manual' LIMIT 1`,
      )
      .get() as { id: string; status: string } | undefined;
    assert.ok(sample, 'seed must contain approved_manual records');
    const actions = (
      db
        .prepare('SELECT action FROM leave_decisions WHERE leave_request_id = ? ORDER BY rowid')
        .all(sample!.id) as Array<{ action: string }>
    ).map((row) => row.action);
    assert.deepEqual(actions, ['submitted', 'manual-review', 'manual-approve']);
    const evaluations = db
      .prepare('SELECT COUNT(*) AS total FROM leave_rule_evaluations WHERE leave_request_id = ?')
      .get(sample!.id) as { total: number };
    assert.equal(evaluations.total, 1);
    const ruleRows = db
      .prepare(
        `SELECT COUNT(*) AS total FROM leave_rule_results r
         JOIN leave_rule_evaluations e ON e.id = r.evaluation_id
         WHERE e.leave_request_id = ?`,
      )
      .get(sample!.id) as { total: number };
    assert.equal(ruleRows.total, 9);

    const rejectedSample = db
      .prepare("SELECT id FROM leave_requests WHERE source = 'seed' AND status = 'rejected_manual' LIMIT 1")
      .get() as { id: string } | undefined;
    assert.ok(rejectedSample);
    const rejectedActions = (
      db
        .prepare('SELECT action FROM leave_decisions WHERE leave_request_id = ? ORDER BY rowid')
        .all(rejectedSample!.id) as Array<{ action: string }>
    ).map((row) => row.action);
    assert.deepEqual(rejectedActions, ['submitted', 'manual-review', 'manual-reject']);

    const cancelledSample = db
      .prepare("SELECT id FROM leave_requests WHERE source = 'seed' AND status = 'cancelled' LIMIT 1")
      .get() as { id: string } | undefined;
    assert.ok(cancelledSample);
    const cancelledActions = (
      db
        .prepare('SELECT action FROM leave_decisions WHERE leave_request_id = ? ORDER BY rowid')
        .all(cancelledSample!.id) as Array<{ action: string }>
    ).map((row) => row.action);
    assert.deepEqual(cancelledActions, ['submitted', 'manual-review', 'cancelled']);
  } finally {
    db.close();
    if (seedDir) rmSync(seedDir, { recursive: true, force: true });
  }
});

test('closed loop: student submit -> auto/manual -> admin decision -> student query', () => {
  const db = openDatabase(join(harness.dbPath, '..', 'closed-loop.sqlite3'));
  try {
    withTransaction(db, () => seedDemoBase(db));

    // student A: low-risk sick leave -> auto approved with evidence
    freeze();
    process.env.CAMPUS_IDEMPOTENCY_KEY = 'closed-loop-auto-0001';
    const auto = createLeave(db, {
      studentId: '202408621',
      studentName: '林同学',
      college: '计算机与人工智能学院',
      className: '软件工程 2401 班',
      leaveType: '病假',
      start: '2026-08-19T09:00:00+08:00',
      end: '2026-08-19T12:00:00+08:00',
      reason: '发烧身体不适前往校医院就诊复查',
    });
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
    const autoRequest = (
      processApprovalJob(db, String((auto.request as Record<string, unknown>).id)).request
    ) as Record<string, unknown>;
    assert.equal(autoRequest.status, 'approved_auto');
    assert.equal(autoRequest.decisionMode, 'auto');
    assert.match(String(autoRequest.decisionSummary), /全部 \d+ 项低风险规则通过/);

    // student B topic: official leave -> manual review
    process.env.CAMPUS_IDEMPOTENCY_KEY = 'closed-loop-manual-0002';
    const manual = createLeave(db, {
      studentId: '202408621',
      studentName: '林同学',
      college: '计算机与人工智能学院',
      className: '软件工程 2401 班',
      leaveType: '公假',
      start: '2026-08-20T09:00:00+08:00',
      end: '2026-08-20T12:00:00+08:00',
      reason: '代表学校参加省级程序设计竞赛联合集训',
    });
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
    const manualRequest = (
      processApprovalJob(db, String((manual.request as Record<string, unknown>).id)).request
    ) as Record<string, unknown>;
    assert.equal(manualRequest.status, 'manual_review');
    const failed = manualRequest.failedRules as Array<{ ruleCode: string }>;
    assert.ok(failed.some((item) => item.ruleCode === 'LEAVE_TYPE_ALLOWED'));

    // admin approves; student query shows the final state and opinion
    const approve = adminApprove(db, { ref: 'admin-closed', name: '闭环管理员' }, String(manualRequest.id), {
      reason: '情况属实',
    });
    assert.equal((approve.request as Record<string, unknown>).status, 'approved_manual');

    const listed = listLeaves(db, '202408621', 10);
    const items = listed.requests as Array<Record<string, unknown>>;
    const manualItem = items.find((item) => item.id === manualRequest.id);
    const autoItem = items.find((item) => item.id === autoRequest.id);
    assert.equal(manualItem?.status, 'approved_manual');
    assert.equal(manualItem?.statusLabel, '已人工批准');
    assert.equal(manualItem?.decisionSummary, '已人工批准：情况属实');
    assert.equal(autoItem?.statusLabel, '已自动批准');

    // student withdraws the auto-approved leave before it starts
    process.env.CAMPUS_IDEMPOTENCY_KEY = 'closed-loop-cancel-0003';
    const cancelled = cancelLeave(db, '202408621', String(autoRequest.id), '行程取消不需要请假了');
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
    assert.equal((cancelled.request as Record<string, unknown>).status, 'cancelled');
  } finally {
    db.close();
  }
});

function freeze(): void {
  process.env.CAMPUS_NOW = '2026-08-18T08:00:00+08:00';
}

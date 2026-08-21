/** Migration tests: legacy JSON -> SQLite, idempotent re-runs, audit prefix. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { verifyChain } from '../audit.ts';
import { canonicalJson, get, openDatabase, sha256, type Row } from '../db.ts';
import { migrateLeaveJson } from '../migrate.ts';
import { setupHarness, type Harness } from './helpers.ts';

const harness: Harness = setupHarness();

const LEGACY_RECORDS = [
  {
    id: 'LV20260801-AAAA01',
    studentId: '202408621',
    studentName: '林同学',
    college: '计算机与人工智能学院',
    className: '软件工程 2401 班',
    leaveType: '病假',
    start: '2026-08-01T09:00:00+08:00',
    end: '2026-08-01T12:00:00+08:00',
    reason: '感冒发烧前往校医院就诊吃药',
    status: 'pending',
    createdAt: '2026-08-01T08:00:00+08:00',
    updatedAt: '2026-08-01T08:00:00+08:00',
    source: 'campus-assistant',
    evidence: { idempotencyKeyHash: 'a'.repeat(64) },
  },
  {
    id: 'LV20260802-BBBB02',
    studentId: '202301001',
    studentName: '周同学',
    college: '外国语学院',
    className: '英语 2301 班',
    leaveType: '事假',
    start: '2026-08-02T14:00:00+08:00',
    end: '2026-08-02T16:00:00+08:00',
    reason: '外出参加学科竞赛培训课程',
    status: 'cancelled',
    createdAt: '2026-08-02T10:00:00+08:00',
    updatedAt: '2026-08-02T11:00:00+08:00',
    source: 'campus-assistant',
    evidence: {},
  },
  {
    id: 'LV20260803-CCCC03',
    studentId: '202301001',
    studentName: '周同学',
    college: '外国语学院',
    className: '英语 2301 班',
    leaveType: '公假',
    start: '2026-08-03T09:00:00+08:00',
    end: '2026-08-03T17:00:00+08:00',
    reason: '代表学校参加省级辩论比赛',
    status: 'pending',
    createdAt: '2026-08-02T18:00:00+08:00',
    updatedAt: '2026-08-02T18:00:00+08:00',
    source: 'campus-assistant',
  },
];

function legacyAuditLines(): string[] {
  const lines: string[] = [];
  let previousHash = '0'.repeat(64);
  const events = [
    { action: 'leave.create', outcome: 'attempt', resourceId: 'LV20260801-AAAA01' },
    { action: 'leave.create', outcome: 'committed', resourceId: 'LV20260801-AAAA01' },
    { action: 'leave.rollback', outcome: 'committed', resourceId: 'LV20260802-BBBB02' },
  ];
  for (const event of events) {
    const unsigned = {
      schemaVersion: 1,
      timestamp: '2026-08-01T08:00:00+08:00',
      requestId: 'legacy-req',
      actorRef: sha256('202408621').slice(0, 20),
      actorIdMasked: '****8621',
      action: event.action,
      outcome: event.outcome,
      resourceId: event.resourceId,
      details: { legacy: true },
      integrityMode: 'demo-sha256',
      previousHash,
    };
    const hash = sha256(canonicalJson(unsigned));
    lines.push(JSON.stringify({ ...unsigned, hash }));
    previousHash = hash;
  }
  return lines;
}

test('migration imports records, maps statuses, keeps audit prefix', () => {
  const dir = harness.dbPath ? join(harness.dbPath, '..') : '.';
  const source = join(dir, 'leave-requests.json');
  const audit = join(dir, 'leave-audit.jsonl');
  writeFileSync(source, JSON.stringify(LEGACY_RECORDS, null, 2), 'utf8');
  writeFileSync(audit, legacyAuditLines().join('\n') + '\n', 'utf8');

  const result = migrateLeaveJson(harness.db, source, audit) as Record<string, unknown>;
  assert.equal(result.imported, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.ok, true);
  assert.equal(result.auditImported, true);

  const pending = get(
    harness.db,
    'SELECT * FROM leave_requests WHERE id = ?',
    'LV20260801-AAAA01',
  ) as Row;
  assert.equal(String(pending.status), 'manual_review'); // pending -> manual_review
  assert.equal(String(pending.leave_type), 'sick');
  assert.equal(String(pending.idempotency_key_hash), 'a'.repeat(64));

  const cancelled = get(
    harness.db,
    'SELECT * FROM leave_requests WHERE id = ?',
    'LV20260802-BBBB02',
  ) as Row;
  assert.equal(String(cancelled.status), 'cancelled'); // cancelled kept

  const migratedStudent = get(
    harness.db,
    'SELECT * FROM students WHERE student_no = ?',
    '202301001',
  ) as Row;
  assert.equal(String(migratedStudent.college_id), 'COLLEGE-UNASSIGNED');

  const chain = verifyChain(harness.db);
  assert.equal(chain.ok, true);
  assert.ok(chain.events >= 3, 'legacy audit imported as prefix');
});

test('migration re-runs without duplicating records', () => {
  const dir = harness.dbPath ? join(harness.dbPath, '..') : '.';
  const source = join(dir, 'leave-requests.json');
  const audit = join(dir, 'leave-audit.jsonl');
  writeFileSync(source, JSON.stringify(LEGACY_RECORDS, null, 2), 'utf8');
  writeFileSync(audit, legacyAuditLines().join('\n') + '\n', 'utf8');

  const first = migrateLeaveJson(harness.db, source, audit) as Record<string, unknown>;
  assert.equal(first.imported, 3);
  assert.equal(first.auditImported, true);
  const second = migrateLeaveJson(harness.db, source, audit) as Record<string, unknown>;
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 3);
  assert.equal(second.auditImported, false); // prefix import skipped on re-run
  const total = get(harness.db, 'SELECT COUNT(*) AS total FROM leave_requests') as Row;
  assert.equal(Number(total.total), 3);
  const chain = verifyChain(harness.db);
  assert.equal(chain.ok, true);
});

test('missing source file is a no-op', () => {
  const db = openDatabase(harness.dbPath);
  try {
    const result = migrateLeaveJson(db, join('Z:', 'missing.json')) as Record<string, unknown>;
    assert.equal(result.imported, 0);
    assert.match(String(result.message), /无需迁移/);
  } finally {
    db.close();
  }
});

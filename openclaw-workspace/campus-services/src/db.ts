/**
 * SQLite connection, migrations and shared helpers for campus services.
 *
 * Plan section 10: standard `node:sqlite` (no external database service),
 * WAL journal, explicit transactions, ordered migrations with checksums, and
 * a freezable clock through CAMPUS_NOW for tests and demos.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, unknown>;

const HERE = dirname(fileURLToPath(import.meta.url));
/** workspace-campus/ root (src/.. is campus-services, its parent is the repo). */
export const WORKSPACE_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_DB_FILE = resolve(WORKSPACE_ROOT, 'data', 'campus-demo.sqlite3');

export const LEAVE_STATUSES = [
  'evaluating',
  'approved_auto',
  'manual_review',
  'approved_manual',
  'rejected_manual',
  'cancelled',
] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const STATUS_LABELS: Record<LeaveStatus, string> = {
  evaluating: '审批中',
  approved_auto: '已自动批准',
  manual_review: '待人工复核',
  approved_manual: '已人工批准',
  rejected_manual: '已人工驳回',
  cancelled: '已撤回',
};

export const LEAVE_TYPE_CODES = ['sick', 'personal', 'official', 'other'] as const;
export type LeaveTypeCode = (typeof LEAVE_TYPE_CODES)[number];

export const LEAVE_TYPE_LABELS: Record<LeaveTypeCode, string> = {
  sick: '病假',
  personal: '事假',
  official: '公假',
  other: '其他',
};
export const LEAVE_TYPE_BY_LABEL: Record<string, LeaveTypeCode> = {
  病假: 'sick',
  事假: 'personal',
  公假: 'official',
  其他: 'other',
};

export function dbPath(): string {
  const override = process.env.CAMPUS_DB_FILE?.trim();
  return resolve(override && override.length > 0 ? override : DEFAULT_DB_FILE);
}

export function connect(path?: string): DatabaseSync {
  if (path === ':memory:') {
    const memory = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    memory.exec('PRAGMA foreign_keys = ON');
    memory.exec('PRAGMA busy_timeout = 5000');
    return memory;
  }
  const target = resolve(path ?? dbPath());
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(target, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Explicit write transaction; rolls back on any exception. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// clock and time helpers
// ---------------------------------------------------------------------------

const ISO_WITH_TZ =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;

export function now(): Date {
  const frozen = process.env.CAMPUS_NOW?.trim();
  if (frozen) {
    const parsed = new Date(frozen);
    if (Number.isNaN(parsed.getTime()) || !ISO_WITH_TZ.test(frozen)) {
      throw new Error('CAMPUS_NOW 必须是带时区的 ISO 8601 时间');
    }
    return parsed;
  }
  return new Date();
}

export function nowIso(): string {
  return isoInLocalOffset(now());
}

/** Format a Date in the machine-local offset, seconds precision (+08:00 on demo hosts). */
export function isoInLocalOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`
  );
}

export function parseDateTime(value: unknown, label: string): Date {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!ISO_WITH_TZ.test(text)) {
    throw new Error(`${label}必须是带时区的 ISO 8601 时间`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label}必须是带时区的 ISO 8601 时间`);
  }
  return parsed;
}

/** Offset in minutes embedded in an ISO string (0 for Z). */
export function offsetMinutesOf(iso: string): number {
  const match = /[Zz]$|([+-]\d{2}):(\d{2})$/.exec(iso);
  if (!match) return 0;
  if (/[Zz]$/.test(iso)) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const magnitude = Math.abs(hours) * 60 + minutes;
  return hours < 0 ? -magnitude : magnitude;
}

/** Calendar-day key of an ISO string in its own offset (SAME_DAY rule). */
export function dayKeyOf(iso: string): number {
  const epochMs = new Date(iso).getTime();
  const localMs = epochMs + offsetMinutesOf(iso) * 60_000;
  return Math.floor(localMs / 86_400_000);
}

// ---------------------------------------------------------------------------
// canonical JSON / hashing / ids
// ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) result[key] = sortValue(item);
    return result;
  }
  return value;
}

/** Deterministic JSON: sorted keys, no spaces, unicode kept raw. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value) as Json);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function shortId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function leaveRequestId(): string {
  const today = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  return `LV${stamp}-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

export function idempotencyKey(): string {
  const value = process.env.CAMPUS_IDEMPOTENCY_KEY?.trim() ?? '';
  if (value && !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new Error('幂等键格式不正确');
  }
  return value;
}

export function requestId(): string {
  return process.env.CAMPUS_REQUEST_ID?.trim() || randomUUID();
}

// ---------------------------------------------------------------------------
// typed query helpers (node:sqlite binds no booleans/undefined)
// ---------------------------------------------------------------------------

/** node:sqlite accepts null / number / bigint / string / Uint8Array only. */
type SQLValue = null | number | bigint | string | Uint8Array;

function bind(params: unknown[]): SQLValue[] {
  return params.map((item): SQLValue => {
    if (typeof item === 'boolean') return item ? 1 : 0;
    if (item === undefined) return null;
    return item as SQLValue;
  });
}

export function run(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const result = db.prepare(sql).run(...bind(params));
  return Number(result.changes);
}

/** Like run() but returns the raw statement result (changes + lastInsertRowid). */
export function runStatement(db: DatabaseSync, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...bind(params));
}

export function get<T extends Row = Row>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...bind(params)) as T | undefined;
}

export function all<T extends Row = Row>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...bind(params)) as T[];
}

export function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function maybeStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// ---------------------------------------------------------------------------
// schema migrations
// ---------------------------------------------------------------------------

const MIGRATIONS: ReadonlyArray<{ version: number; name: string; statements: readonly string[] }> = [
  {
    version: 1,
    name: 'base-schema',
    statements: [
      `CREATE TABLE schools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE colleges (
        id TEXT PRIMARY KEY,
        school_id TEXT NOT NULL REFERENCES schools(id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (school_id, code)
      )`,
      `CREATE TABLE classes (
        id TEXT PRIMARY KEY,
        college_id TEXT NOT NULL REFERENCES colleges(id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        grade_year INTEGER NOT NULL,
        major_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE students (
        id TEXT PRIMARY KEY,
        student_no TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        college_id TEXT NOT NULL REFERENCES colleges(id),
        class_id TEXT NOT NULL REFERENCES classes(id),
        enrollment_year INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','graduated')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_students_college ON students(college_id)`,
      `CREATE INDEX idx_students_class ON students(class_id)`,
      `CREATE TABLE leave_requests (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES students(id),
        leave_type TEXT NOT NULL CHECK (leave_type IN ('sick','personal','official','other')),
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 4 AND 500),
        status TEXT NOT NULL CHECK (status IN
          ('evaluating','approved_auto','manual_review','approved_manual','rejected_manual','cancelled')),
        source TEXT NOT NULL DEFAULT 'campus-assistant',
        submitted_at TEXT NOT NULL,
        decided_at TEXT,
        decision_mode TEXT CHECK (decision_mode IS NULL OR decision_mode IN ('auto','manual')),
        decision_reason TEXT,
        rule_version INTEGER,
        idempotency_key_hash TEXT UNIQUE,
        emergency_contact_json TEXT,
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_leave_student ON leave_requests(student_id, submitted_at)`,
      `CREATE INDEX idx_leave_status ON leave_requests(status, submitted_at)`,
      `CREATE INDEX idx_leave_college_path ON leave_requests(student_id, status)`,
      `CREATE TABLE leave_rule_evaluations (
        id TEXT PRIMARY KEY,
        leave_request_id TEXT NOT NULL REFERENCES leave_requests(id),
        rule_version INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('approved_auto','manual_review')),
        evaluated_at TEXT NOT NULL,
        error_code TEXT
      )`,
      `CREATE INDEX idx_evaluations_request ON leave_rule_evaluations(leave_request_id)`,
      `CREATE TABLE leave_rule_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        evaluation_id TEXT NOT NULL REFERENCES leave_rule_evaluations(id),
        rule_code TEXT NOT NULL,
        passed INTEGER NOT NULL CHECK (passed IN (0,1)),
        actual_json TEXT,
        expected_json TEXT,
        message TEXT NOT NULL,
        sequence INTEGER NOT NULL
      )`,
      `CREATE TABLE leave_decisions (
        id TEXT PRIMARY KEY,
        leave_request_id TEXT NOT NULL REFERENCES leave_requests(id),
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_ref TEXT,
        actor_name TEXT,
        reason TEXT,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        request_id TEXT,
        idempotency_key_hash TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_decisions_request ON leave_decisions(leave_request_id)`,
      `CREATE TABLE approval_rules (
        id TEXT PRIMARY KEY,
        rule_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        config_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        actor_ref TEXT,
        actor_role TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        outcome TEXT,
        request_id TEXT,
        details_json TEXT,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        integrity_mode TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_audit_action ON audit_events(action, created_at)`,
    ],
  },
  {
    version: 2,
    name: 'admin-agent-approval-jobs',
    statements: [
      `CREATE TABLE leave_approval_jobs (
        id TEXT PRIMARY KEY,
        leave_request_id TEXT NOT NULL UNIQUE REFERENCES leave_requests(id),
        status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        result_status TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_approval_jobs_status
       ON leave_approval_jobs(status, available_at, created_at)`,
    ],
  },
];

function migrationChecksum(statements: readonly string[]): string {
  return sha256(statements.map((item) => item.trim()).join('\n'));
}

export function applyMigrations(db: DatabaseSync): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Map<number, string>();
  for (const row of all<{ version: unknown; checksum: unknown }>(
    db,
    'SELECT version, checksum FROM schema_migrations',
  )) {
    applied.set(Number(row.version), String(row.checksum));
  }
  for (const migration of MIGRATIONS) {
    const expected = migrationChecksum(migration.statements);
    const existing = applied.get(migration.version);
    if (existing !== undefined) {
      if (existing !== expected) {
        throw new Error(`迁移 ${migration.version} 校验和不一致：已应用结构与代码不符`);
      }
      continue;
    }
    withTransaction(db, () => {
      for (const statement of migration.statements) db.exec(statement);
      run(
        db,
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        migration.version,
        migration.name,
        expected,
        nowIso(),
      );
    });
  }
  return [...applied.keys(), ...MIGRATIONS.map((item) => item.version)].sort((a, b) => a - b);
}

/** Open a connection and bring the schema up to date. */
export function openDatabase(path?: string): DatabaseSync {
  const db = connect(path);
  applyMigrations(db);
  return db;
}

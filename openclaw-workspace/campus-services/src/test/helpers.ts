/** Shared test fixtures: temp database, seeded base data, env save/restore. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';

import { openDatabase, withTransaction } from '../db.ts';
import { seedDemoBase } from '../seed.ts';

export interface Harness {
  dbPath: string;
  db: ReturnType<typeof openDatabase>;
  cleanup: () => void;
}

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED = ['CAMPUS_DB_FILE', 'CAMPUS_NOW', 'CAMPUS_IDEMPOTENCY_KEY', 'CAMPUS_REQUEST_ID', 'CAMPUS_AUDIT_SECRET'];

export function setupHarness(): Harness {
  let dir: string | null = null;
  let db: ReturnType<typeof openDatabase> | null = null;

  beforeEach(() => {
    for (const key of TRACKED) SAVED_ENV[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), 'campus-services-test-'));
    const path = join(dir, 'campus-demo.sqlite3');
    process.env.CAMPUS_DB_FILE = path;
    delete process.env.CAMPUS_NOW;
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
    delete process.env.CAMPUS_REQUEST_ID;
    delete process.env.CAMPUS_AUDIT_SECRET;
    const connection = openDatabase();
    db = connection;
    withTransaction(connection, () => seedDemoBase(connection));
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const key of TRACKED) {
      if (SAVED_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED_ENV[key];
    }
  });

  return {
    get dbPath() {
      return process.env.CAMPUS_DB_FILE as string;
    },
    get db() {
      if (!db) throw new Error('harness used outside beforeEach');
      return db;
    },
    cleanup() {
      db?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Freeze the clock at a fixed instant (all rules anchor on it). */
export function freezeAt(iso: string): void {
  process.env.CAMPUS_NOW = iso;
}

export function withIdempotencyKey(key: string, fn: () => void): void {
  process.env.CAMPUS_IDEMPOTENCY_KEY = key;
  try {
    fn();
  } finally {
    delete process.env.CAMPUS_IDEMPOTENCY_KEY;
  }
}

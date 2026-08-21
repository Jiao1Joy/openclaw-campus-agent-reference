#!/usr/bin/env node
/**
 * Initialize (or bring up to date) the demo SQLite database:
 * apply migrations, then seed the baseline school/class/student and the
 * default approval rules. Idempotent — safe to run repeatedly.
 */
import { openDatabase, withTransaction } from '../db.ts';
import { seedDemoBase } from '../seed.ts';
import { runCli } from '../cli.ts';

runCli(() => {
  const db = openDatabase();
  try {
    const before = db
      .prepare('SELECT COUNT(*) AS total FROM schema_migrations')
      .get() as { total: unknown };
    withTransaction(db, () => seedDemoBase(db));
    const after = db
      .prepare('SELECT COUNT(*) AS total FROM schema_migrations')
      .get() as { total: unknown };
    const students = db.prepare('SELECT COUNT(*) AS total FROM students').get() as {
      total: unknown;
    };
    return {
      ok: true,
      action: 'init-demo-db',
      migrationsBefore: Number(before.total ?? 0),
      migrationsAfter: Number(after.total ?? 0),
      students: Number(students.total ?? 0),
    };
  } finally {
    db.close();
  }
});

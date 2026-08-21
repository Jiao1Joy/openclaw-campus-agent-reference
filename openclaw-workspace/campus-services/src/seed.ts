/**
 * Baseline demo data seeding (plan sections 7/13).
 *
 * `seedDemoBase` installs one fictional school, one college, one class, the
 * demo student used by the student portal and the default approval rules.
 * All inserts are idempotent so init/reset can run repeatedly.
 */
import type { DatabaseSync } from 'node:sqlite';

import { seedDefaultRules } from './approvalEngine.ts';
import { nowIso, run } from './db.ts';

export const DEMO_SCHOOL_ID = 'SCH-YUNCHUAN';
export const DEMO_COLLEGE_ID = 'COLLEGE-CSAI';
export const DEMO_CLASS_ID = 'CLASS-CSAI-SE2401';
export const DEMO_STUDENT_NO = '202408621';

/** Idempotent baseline seed; caller wraps in a transaction. */
export function seedDemoBase(db: DatabaseSync): void {
  const stamp = nowIso();
  run(
    db,
    `INSERT OR IGNORE INTO schools (id, name, timezone, status, created_at, updated_at)
     VALUES (?, '云川大学', 'Asia/Shanghai', 'active', ?, ?)`,
    DEMO_SCHOOL_ID,
    stamp,
    stamp,
  );
  run(
    db,
    `INSERT OR IGNORE INTO colleges (id, school_id, code, name, status, created_at, updated_at)
     VALUES (?, ?, 'CSAI', '计算机与人工智能学院', 'active', ?, ?)`,
    DEMO_COLLEGE_ID,
    DEMO_SCHOOL_ID,
    stamp,
    stamp,
  );
  run(
    db,
    `INSERT OR IGNORE INTO classes
       (id, college_id, code, name, grade_year, major_name, status, created_at, updated_at)
     VALUES (?, ?, 'SE2401', '软件工程 2401 班', 2024, '软件工程', 'active', ?, ?)`,
    DEMO_CLASS_ID,
    DEMO_COLLEGE_ID,
    stamp,
    stamp,
  );
  run(
    db,
    `INSERT OR IGNORE INTO students
       (id, student_no, name, college_id, class_id, enrollment_year, status, created_at, updated_at)
     VALUES (?, ?, '林同学', ?, ?, 2024, 'active', ?, ?)`,
    DEMO_STUDENT_NO,
    DEMO_STUDENT_NO,
    DEMO_COLLEGE_ID,
    DEMO_CLASS_ID,
    stamp,
    stamp,
  );
  seedDefaultRules(db, 'system');
}

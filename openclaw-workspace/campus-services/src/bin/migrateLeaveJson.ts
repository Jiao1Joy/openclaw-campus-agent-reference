#!/usr/bin/env node
/** CLI wrapper: migrateLeaveJson.ts [leave-requests.json] [leave-audit.jsonl] */
import { join } from 'node:path';

import { openDatabase, WORKSPACE_ROOT } from '../db.ts';
import { migrateLeaveJson } from '../migrate.ts';
import { runCli } from '../cli.ts';

const source =
  process.argv[2] ??
  process.env.CAMPUS_MIGRATE_SOURCE ??
  join(WORKSPACE_ROOT, 'data', 'leave-requests.json');
const legacyAudit =
  process.argv[3] ??
  process.env.CAMPUS_MIGRATE_AUDIT ??
  join(WORKSPACE_ROOT, 'data', 'audit', 'leave.jsonl');

runCli(() => {
  const db = openDatabase();
  try {
    return migrateLeaveJson(db, source, legacyAudit);
  } finally {
    db.close();
  }
});

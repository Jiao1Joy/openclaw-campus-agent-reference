#!/usr/bin/env node
/**
 * Student leave CLI — drop-in replacement for the legacy python engine.
 *
 * Subcommands: create / list / cancel / verify-audit with identical flags,
 * env contract (CAMPUS_IDEMPOTENCY_KEY, CAMPUS_REQUEST_ID, CAMPUS_DB_FILE)
 * and output shapes, but backed by SQLite + the auto-approval engine.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../db.ts';
import { CampusServiceError } from '../errors.ts';
import { cancelLeave, createLeave, listLeaves, verifyAudit } from '../leaveService.ts';
import { parseFlags, runCli } from '../cli.ts';

const USAGE = '用法: leaveManagerCli <create|list|cancel|verify-audit> [参数]';

export function runLeaveManagerCli(argv: readonly string[] = process.argv.slice(2)): void {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  runCli(() => {
    const db = openDatabase();
    try {
      switch (command) {
        case 'create':
          return createLeave(db, {
            studentId: flags.get('student-id') ?? '',
            studentName: flags.get('student-name') ?? '',
            college: flags.get('college') ?? '',
            className: flags.get('class-name') ?? '',
            leaveType: flags.get('leave-type') ?? '',
            start: flags.get('start') ?? '',
            end: flags.get('end') ?? '',
            reason: flags.get('reason') ?? '',
            emergencyContactName: flags.get('emergency-contact-name') || undefined,
            emergencyContactPhone: flags.get('emergency-contact-phone') || undefined,
          });
        case 'list': {
          const limit = Number(flags.get('limit') ?? 10);
          return listLeaves(db, flags.get('student-id') ?? '', limit);
        }
        case 'cancel':
          return cancelLeave(
            db,
            flags.get('student-id') ?? '',
            flags.get('request-id') ?? '',
            flags.get('reason') ?? '学生确认取消请假申请',
          );
        case 'verify-audit':
          return verifyAudit(db);
        default:
          throw new CampusServiceError('UNKNOWN_COMMAND', USAGE, 400);
      }
    } finally {
      db.close();
    }
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runLeaveManagerCli();
}

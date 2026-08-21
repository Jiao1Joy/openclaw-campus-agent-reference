#!/usr/bin/env node
/** Private CLI used only by the campus-admin Agent approval Skill. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  approvalJobStatus,
  failApprovalJob,
  listQueuedApprovalJobs,
  processApprovalJob,
} from '../approvalAgentService.ts';
import { parseFlags, runCli } from '../cli.ts';
import { openDatabase } from '../db.ts';
import { CampusServiceError } from '../errors.ts';

const USAGE = '用法: approvalAgentCli <next|process|status|fail> [--request-id 编号]';

export function runApprovalAgentCli(argv: readonly string[] = process.argv.slice(2)): void {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  runCli(() => {
    const db = openDatabase();
    try {
      const requestId = flags.get('request-id') ?? '';
      switch (command) {
        case 'next':
          return listQueuedApprovalJobs(db, Number(flags.get('limit') ?? 10));
        case 'process':
          if (!requestId) throw new CampusServiceError('INVALID_REQUEST_ID', '必须提供申请编号');
          return processApprovalJob(db, requestId);
        case 'status':
          if (!requestId) throw new CampusServiceError('INVALID_REQUEST_ID', '必须提供申请编号');
          return approvalJobStatus(db, requestId);
        case 'fail':
          if (!requestId) throw new CampusServiceError('INVALID_REQUEST_ID', '必须提供申请编号');
          return failApprovalJob(db, requestId, flags.get('error') ?? '管理员 Agent 执行失败');
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

if (isMainModule()) runApprovalAgentCli();

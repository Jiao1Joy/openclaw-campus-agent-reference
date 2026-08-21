#!/usr/bin/env node
/**
 * Admin CLI — stdin JSON in, single-line JSON out, exit 0/2/1.
 *
 * Commands (plan section 11): dashboard, leave-list, leave-detail,
 * leave-approve, leave-reject, leave-batch-approve, school-get/patch,
 * college-*, class-*, student-*, rules-get/put/reset, audit-list,
 * demo-reset, demo-import-seed, student-leave-list/detail/cancel.
 *
 * Actor identity comes from env (set by the Node server layer):
 *   CAMPUS_ADMIN_REF / CAMPUS_ADMIN_NAME / CAMPUS_IDEMPOTENCY_KEY.
 */
import { readFileSync } from 'node:fs';
import { openDatabase } from '../db.ts';
import { CampusServiceError } from '../errors.ts';
import {
  adminApprove,
  adminBatchApprove,
  adminDashboard,
  adminLeaveDetail,
  adminListLeaves,
  adminReject,
  auditList,
  classesCreate,
  classesList,
  classesPatch,
  collegesCreate,
  collegesList,
  collegesPatch,
  demoReset,
  rulesGet,
  rulesPut,
  rulesReset,
  schoolGet,
  schoolPatch,
  studentsCreate,
  studentsList,
  studentsPatch,
  type AdminActor,
} from '../adminService.ts';
import type { RuleUpdate } from '../approvalEngine.ts';
import { cancelLeave, leaveDetail, listLeaves } from '../leaveService.ts';
import { importDemoSeed } from './importDemoSeed.ts';
import { runCli } from '../cli.ts';

interface AdminPayload {
  [key: string]: unknown;
}

function readStdinJson(): AdminPayload {
  let raw = '';
  if (!process.stdin.isTTY) {
    try {
      raw = readFileSync(0, 'utf8');
    } catch {
      raw = '';
    }
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AdminPayload;
    }
  } catch {
    throw new CampusServiceError('INVALID_PAYLOAD', '请求体必须是 JSON 对象');
  }
  throw new CampusServiceError('INVALID_PAYLOAD', '请求体必须是 JSON 对象');
}

function actor(): AdminActor {
  const ref = process.env.CAMPUS_ADMIN_REF?.trim() || 'admin';
  const name = process.env.CAMPUS_ADMIN_NAME?.trim() || '校园管理员';
  const idempotencyKey = process.env.CAMPUS_IDEMPOTENCY_KEY?.trim() || undefined;
  return { ref, name, idempotencyKey };
}

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function asRuleUpdates(value: unknown): RuleUpdate[] {
  if (!Array.isArray(value)) {
    throw new CampusServiceError('INVALID_PAYLOAD', 'rules 必须是数组');
  }
  return value.map((item) => {
    if (item === null || typeof item !== 'object') {
      throw new CampusServiceError('INVALID_PAYLOAD', 'rules 数组元素必须是对象');
    }
    const entry = item as Record<string, unknown>;
    const update: RuleUpdate = { ruleCode: asString(entry.ruleCode) };
    if (entry.enabled !== undefined) update.enabled = Boolean(entry.enabled);
    if (entry.config !== undefined && entry.config !== null) {
      if (typeof entry.config !== 'object' || Array.isArray(entry.config)) {
        throw new CampusServiceError('INVALID_PAYLOAD', 'config 必须是对象');
      }
      update.config = entry.config as Record<string, unknown>;
    }
    return update;
  });
}

const USAGE = '用法: campusAdminCli <command>（参数从 stdin 读取 JSON）';

const command = process.argv[2] ?? '';

runCli(() => {
  const payload = readStdinJson();
  const db = openDatabase();
  try {
    const admin = actor();
    switch (command) {
      case 'dashboard':
        return adminDashboard(db);
      case 'leave-list':
        return adminListLeaves(db, {
          status: asString(payload.status) || undefined,
          collegeId: asString(payload.collegeId) || undefined,
          classId: asString(payload.classId) || undefined,
          leaveType: asString(payload.leaveType) || undefined,
          keyword: asString(payload.keyword) || undefined,
          dateFrom: asString(payload.dateFrom) || undefined,
          dateTo: asString(payload.dateTo) || undefined,
          page: payload.page === undefined ? undefined : Number(payload.page),
          pageSize: payload.pageSize === undefined ? undefined : Number(payload.pageSize),
        });
      case 'leave-detail':
        return adminLeaveDetail(db, asString(payload.id));
      case 'leave-approve':
        return adminApprove(db, admin, asString(payload.id), {
          reason: asString(payload.reason) || undefined,
          rowVersion: payload.rowVersion === undefined ? undefined : Number(payload.rowVersion),
        });
      case 'leave-reject':
        return adminReject(db, admin, asString(payload.id), {
          reason: asString(payload.reason),
          rowVersion: payload.rowVersion === undefined ? undefined : Number(payload.rowVersion),
        });
      case 'leave-batch-approve':
        return adminBatchApprove(
          db,
          admin,
          Array.isArray(payload.ids) ? payload.ids.map(String) : [],
        );
      case 'school-get':
        return schoolGet(db);
      case 'school-patch':
        return schoolPatch(db, admin, payload);
      case 'college-list':
        return collegesList(db);
      case 'college-create':
        return collegesCreate(db, admin, payload);
      case 'college-patch':
        return collegesPatch(db, admin, payload);
      case 'class-list':
        return classesList(db, asString(payload.collegeId) || undefined);
      case 'class-create':
        return classesCreate(db, admin, payload);
      case 'class-patch':
        return classesPatch(db, admin, payload);
      case 'student-list':
        return studentsList(db, {
          collegeId: asString(payload.collegeId) || undefined,
          classId: asString(payload.classId) || undefined,
          keyword: asString(payload.keyword) || undefined,
          page: payload.page === undefined ? undefined : Number(payload.page),
          pageSize: payload.pageSize === undefined ? undefined : Number(payload.pageSize),
        });
      case 'student-create':
        return studentsCreate(db, admin, payload);
      case 'student-patch':
        return studentsPatch(db, admin, payload);
      case 'rules-get':
        return rulesGet(db);
      case 'rules-put':
        return rulesPut(db, admin, asRuleUpdates(payload.rules));
      case 'rules-reset':
        return rulesReset(db, admin);
      case 'audit-list':
        return auditList(db, {
          action: asString(payload.action) || undefined,
          page: payload.page === undefined ? undefined : Number(payload.page),
          pageSize: payload.pageSize === undefined ? undefined : Number(payload.pageSize),
        });
      case 'demo-reset':
        return demoReset(db, admin, asString(payload.confirmPhrase) || '');
      case 'demo-import-seed':
        return importDemoSeed(db, asString(payload.seedDir) || 'demo/auto-approval/seed');
      // student-facing passthroughs used by the school-web server layer
      case 'student-leave-list':
        return listLeaves(
          db,
          asString(payload.studentNo),
          payload.limit === undefined ? 10 : Number(payload.limit),
        );
      case 'student-leave-detail':
        return leaveDetail(db, asString(payload.studentNo) || null, asString(payload.id));
      case 'student-leave-cancel':
        return cancelLeave(
          db,
          asString(payload.studentNo),
          asString(payload.id),
          asString(payload.reason) || '学生确认取消请假申请',
        );
      default:
        throw new CampusServiceError('UNKNOWN_COMMAND', USAGE, 404);
    }
  } finally {
    db.close();
  }
});

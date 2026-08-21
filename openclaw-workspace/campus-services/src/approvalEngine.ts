/**
 * Deterministic auto-approval rule engine (plan section 9).
 *
 * Contract:
 * - same request + same rule snapshot => same outcome, always;
 * - ALL enabled rules must pass for `approved_auto`; any failure (or engine
 *   error) degrades protectively to `manual_review`;
 * - no rule ever produces an automatic rejection;
 * - every rule emits structured evidence {ruleCode, passed, actual, expected,
 *   message} so the student and the admin can both explain the outcome.
 *
 * Rule versions are global: any modification re-versions every rule row in
 * one transaction, and each evaluation snapshots the whole set.
 */
import type { DatabaseSync } from 'node:sqlite';

import {
  all,
  canonicalJson,
  dayKeyOf,
  isoInLocalOffset,
  nowIso,
  parseDateTime,
  run,
  shortId,
  type Row,
} from './db.ts';

export const RULE_ORDER = [
  'LEAVE_TYPE_ALLOWED',
  'REASON_COMPLETE',
  'FUTURE_REQUEST',
  'DATE_RANGE_ALLOWED',
  'SAME_DAY',
  'DURATION_LIMIT',
  'NO_OVERLAP',
  'FREQUENCY_LIMIT',
  'STUDENT_ACTIVE',
] as const;
export type RuleCode = (typeof RULE_ORDER)[number];

export const RULE_NAMES: Record<RuleCode, string> = {
  LEAVE_TYPE_ALLOWED: '假别范围',
  REASON_COMPLETE: '原因完整',
  FUTURE_REQUEST: '提前申请',
  DATE_RANGE_ALLOWED: '申请区间',
  SAME_DAY: '同日请假',
  DURATION_LIMIT: '时长上限',
  NO_OVERLAP: '时段不重叠',
  FREQUENCY_LIMIT: '频次上限',
  STUDENT_ACTIVE: '学生在读',
};

export interface RuleSpec {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export const DEFAULT_RULES: Record<RuleCode, RuleSpec> = {
  LEAVE_TYPE_ALLOWED: {
    name: '假别范围',
    enabled: true,
    config: { allowedTypes: ['sick', 'personal'] },
  },
  REASON_COMPLETE: {
    name: '原因完整',
    enabled: true,
    config: { minLength: 8, maxLength: 200, placeholders: ['无', '不知道', '随便', '测试'] },
  },
  FUTURE_REQUEST: {
    name: '提前申请',
    enabled: true,
    config: { minLeadMinutes: 120 },
  },
  DATE_RANGE_ALLOWED: {
    name: '申请区间',
    enabled: true,
    config: { maxFutureDays: 30 },
  },
  SAME_DAY: { name: '同日请假', enabled: true, config: {} },
  DURATION_LIMIT: { name: '时长上限', enabled: true, config: { maxMinutes: 480 } },
  NO_OVERLAP: { name: '时段不重叠', enabled: true, config: {} },
  FREQUENCY_LIMIT: {
    name: '频次上限',
    enabled: true,
    config: { windowDays: 30, maxCount: 3, maxTotalMinutes: 1440 },
  },
  STUDENT_ACTIVE: { name: '学生在读', enabled: true, config: {} },
};

export interface RuleResult {
  ruleCode: RuleCode;
  ruleName: string;
  passed: boolean;
  actual: Record<string, unknown>;
  expected: Record<string, unknown>;
  message: string;
}

export interface RuleSnapshot {
  version: number;
  rules: Partial<Record<RuleCode, RuleSpec>>;
}

export interface Evaluation {
  outcome: 'approved_auto' | 'manual_review';
  version: number;
  results: RuleResult[];
  errorCode: string | null;
  evaluatedAt: string;
}

export interface RuleContext {
  db: DatabaseSync;
  studentRow: Row;
  studentId: string;
  leaveType: string;
  startIso: string;
  endIso: string;
  start: Date;
  end: Date;
  reason: string;
  submittedAt: Date;
  leaveRequestId: string;
}

// ---------------------------------------------------------------------------
// individual rules
// ---------------------------------------------------------------------------

function checkLeaveType(ctx: RuleContext, config: Record<string, unknown>): RuleResult {
  const allowed = Array.isArray(config.allowedTypes)
    ? (config.allowedTypes as string[])
    : ['sick', 'personal'];
  const passed = allowed.includes(ctx.leaveType);
  return {
    ruleCode: 'LEAVE_TYPE_ALLOWED',
    ruleName: RULE_NAMES.LEAVE_TYPE_ALLOWED,
    passed,
    actual: { leaveType: ctx.leaveType },
    expected: { allowedTypes: allowed },
    message: passed ? '假别属于可自动批准范围' : '该假别需要人工复核',
  };
}

function checkReasonComplete(ctx: RuleContext, config: Record<string, unknown>): RuleResult {
  const minimum = Number(config.minLength ?? 8);
  const maximum = Number(config.maxLength ?? 200);
  const placeholders = Array.isArray(config.placeholders)
    ? (config.placeholders as unknown[]).map(String)
    : [];
  const reason = ctx.reason.trim();
  const length = [...reason].length;
  const placeholderHit = placeholders.includes(reason);
  const repeated = length >= 4 && new Set([...reason]).size === 1;
  const passed = length >= minimum && length <= maximum && !placeholderHit && !repeated;
  let message = '请假原因表述完整';
  if (length < minimum || length > maximum) {
    message = `原因长度需在 ${minimum} 到 ${maximum} 字之间`;
  } else if (placeholderHit) {
    message = '原因属于占位文本，需要人工复核';
  } else if (repeated) {
    message = '原因为纯重复字符，需要人工复核';
  }
  return {
    ruleCode: 'REASON_COMPLETE',
    ruleName: RULE_NAMES.REASON_COMPLETE,
    passed,
    actual: { length, placeholder: placeholderHit, repeated },
    expected: { minLength: minimum, maxLength: maximum },
    message,
  };
}

function checkFutureRequest(ctx: RuleContext, config: Record<string, unknown>): RuleResult {
  const leadMinutes = Number(config.minLeadMinutes ?? 120);
  const deltaMinutes = (ctx.start.getTime() - ctx.submittedAt.getTime()) / 60_000;
  const passed = deltaMinutes >= leadMinutes;
  return {
    ruleCode: 'FUTURE_REQUEST',
    ruleName: RULE_NAMES.FUTURE_REQUEST,
    passed,
    actual: { leadMinutes: Math.round(deltaMinutes * 10) / 10 },
    expected: { minLeadMinutes: leadMinutes },
    message: passed
      ? `距开始时间不少于 ${Math.floor(leadMinutes / 60)} 小时`
      : '申请时间距离开始不足，需要人工复核',
  };
}

function checkDateRange(ctx: RuleContext, config: Record<string, unknown>): RuleResult {
  const maxDays = Number(config.maxFutureDays ?? 30);
  const horizonMs = ctx.submittedAt.getTime() + maxDays * 86_400_000;
  const passed = ctx.start.getTime() <= horizonMs;
  return {
    ruleCode: 'DATE_RANGE_ALLOWED',
    ruleName: RULE_NAMES.DATE_RANGE_ALLOWED,
    passed,
    actual: {
      daysAhead: dayKeyOf(ctx.startIso) - dayKeyOf(isoInLocalOffset(ctx.submittedAt)),
    },
    expected: { maxFutureDays: maxDays },
    message: passed ? `开始时间在提交后 ${maxDays} 天以内` : '开始时间过远，需要人工复核',
  };
}

function checkSameDay(ctx: RuleContext, _config: Record<string, unknown>): RuleResult {
  const passed = dayKeyOf(ctx.startIso) === dayKeyOf(ctx.endIso);
  return {
    ruleCode: 'SAME_DAY',
    ruleName: RULE_NAMES.SAME_DAY,
    passed,
    actual: {
      startDay: localDateString(ctx.startIso),
      endDay: localDateString(ctx.endIso),
    },
    expected: {},
    message: passed ? '开始和结束位于同一自然日' : '跨日请假需要人工复核',
  };
}

function checkDuration(ctx: RuleContext, config: Record<string, unknown>): RuleResult {
  const maximum = Number(config.maxMinutes ?? 480);
  const minutes = (ctx.end.getTime() - ctx.start.getTime()) / 60_000;
  const passed = minutes > 0 && minutes <= maximum;
  return {
    ruleCode: 'DURATION_LIMIT',
    ruleName: RULE_NAMES.DURATION_LIMIT,
    passed,
    actual: { durationMinutes: Math.round(minutes) },
    expected: { maxMinutes: maximum },
    message: passed ? `请假时长不超过 ${maximum / 60} 小时` : '请假时长超过上限，需要人工复核',
  };
}

function checkNoOverlap(ctx: RuleContext, _config: Record<string, unknown>): RuleResult {
  const rows = all<{ id: unknown; start_at: unknown; end_at: unknown }>(
    ctx.db,
    `SELECT id, start_at, end_at FROM leave_requests
     WHERE student_id = ?
       AND status IN ('approved_auto','manual_review','approved_manual','evaluating')
       AND id != ?`,
    ctx.studentId,
    ctx.leaveRequestId,
  );
  const overlapping: string[] = [];
  for (const row of rows) {
    const existingStart = parseDateTime(row.start_at, '开始时间');
    const existingEnd = parseDateTime(row.end_at, '结束时间');
    if (existingStart < ctx.end && existingEnd > ctx.start) {
      overlapping.push(String(row.id));
    }
  }
  return {
    ruleCode: 'NO_OVERLAP',
    ruleName: RULE_NAMES.NO_OVERLAP,
    passed: overlapping.length === 0,
    actual: { overlappingRequests: overlapping },
    expected: {},
    message:
      overlapping.length === 0 ? '与现有请假时段不重叠' : '与现有请假时段重叠，需要人工复核',
  };
}

function checkFrequency(ctx: RuleContext, config: Record<string, unknown>): RuleResult {
  const windowDays = Number(config.windowDays ?? 30);
  const maxCount = Number(config.maxCount ?? 3);
  const maxTotal = Number(config.maxTotalMinutes ?? 1440);
  const windowStartMs = ctx.submittedAt.getTime() - windowDays * 86_400_000;
  const rows = all<{ start_at: unknown; end_at: unknown; decided_at: unknown }>(
    ctx.db,
    `SELECT start_at, end_at, decided_at FROM leave_requests
     WHERE student_id = ?
       AND status IN ('approved_auto','approved_manual')
       AND id != ?`,
    ctx.studentId,
    ctx.leaveRequestId,
  );
  let count = 0;
  let totalMinutes = 0;
  for (const row of rows) {
    const decidedAt = row.decided_at;
    if (decidedAt === null || decidedAt === undefined) continue;
    const anchor = parseDateTime(decidedAt, '决定时间');
    if (anchor.getTime() < windowStartMs || anchor.getTime() > ctx.submittedAt.getTime()) continue;
    count += 1;
    totalMinutes +=
      (parseDateTime(row.end_at, '结束时间').getTime() -
        parseDateTime(row.start_at, '开始时间').getTime()) /
      60_000;
  }
  const currentMinutes = (ctx.end.getTime() - ctx.start.getTime()) / 60_000;
  const countOk = count < maxCount;
  const totalOk = totalMinutes + currentMinutes <= maxTotal;
  let message = '近 30 天请假频次正常';
  if (!countOk) {
    message = `过去 ${windowDays} 天已批准次数达到上限，需要人工复核`;
  } else if (!totalOk) {
    message = `过去 ${windowDays} 天累计批准时长接近上限，需要人工复核`;
  }
  return {
    ruleCode: 'FREQUENCY_LIMIT',
    ruleName: RULE_NAMES.FREQUENCY_LIMIT,
    passed: countOk && totalOk,
    actual: {
      approvedCount: count,
      approvedMinutes: Math.round(totalMinutes),
      plusCurrentMinutes: Math.round(totalMinutes + currentMinutes),
    },
    expected: { windowDays, maxCount, maxTotalMinutes: maxTotal },
    message,
  };
}

function checkStudentActive(ctx: RuleContext, _config: Record<string, unknown>): RuleResult {
  const status = String(ctx.studentRow.status ?? '');
  const passed = status === 'active';
  return {
    ruleCode: 'STUDENT_ACTIVE',
    ruleName: RULE_NAMES.STUDENT_ACTIVE,
    passed,
    actual: { studentStatus: status },
    expected: { requiredStatus: 'active' },
    message: passed ? '学生在读且未停用' : '学生状态异常，需要人工复核',
  };
}

const RULE_CHECKS: {
  [K in RuleCode]: (ctx: RuleContext, config: Record<string, unknown>) => RuleResult;
} = {
  LEAVE_TYPE_ALLOWED: checkLeaveType,
  REASON_COMPLETE: checkReasonComplete,
  FUTURE_REQUEST: checkFutureRequest,
  DATE_RANGE_ALLOWED: checkDateRange,
  SAME_DAY: checkSameDay,
  DURATION_LIMIT: checkDuration,
  NO_OVERLAP: checkNoOverlap,
  FREQUENCY_LIMIT: checkFrequency,
  STUDENT_ACTIVE: checkStudentActive,
};

function localDateString(iso: string): string {
  const epoch = new Date(iso).getTime();
  const localMs = epoch + offsetOf(iso) * 60_000;
  const date = new Date(localMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function offsetOf(iso: string): number {
  const match = /([+-]\d{2}):(\d{2})$/.exec(iso);
  if (!match) return 0;
  const hours = Number(match[1]);
  const magnitude = Math.abs(hours) * 60 + Number(match[2]);
  return hours < 0 ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------
// snapshot loading and persistence
// ---------------------------------------------------------------------------

export function seedDefaultRules(db: DatabaseSync, updatedBy = 'system'): void {
  const stamp = nowIso();
  for (const code of RULE_ORDER) {
    const spec = DEFAULT_RULES[code];
    run(
      db,
      `INSERT OR IGNORE INTO approval_rules
        (id, rule_code, name, enabled, config_json, version, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      `RULE-${code}`,
      code,
      spec.name,
      spec.enabled ? 1 : 0,
      canonicalJson(spec.config),
      updatedBy,
      stamp,
      stamp,
    );
  }
}

export function loadRuleSnapshot(db: DatabaseSync): RuleSnapshot {
  const rows = all<{
    rule_code: unknown;
    name: unknown;
    enabled: unknown;
    config_json: unknown;
    version: unknown;
  }>(db, 'SELECT rule_code, name, enabled, config_json, version FROM approval_rules');
  if (rows.length === 0) {
    throw new Error('规则配置缺失');
  }
  const versions = rows.map((row) => Number(row.version));
  const version = Math.max(...versions);
  if (versions.some((item) => item !== version)) {
    throw new Error('规则版本不一致');
  }
  const rules: Partial<Record<RuleCode, RuleSpec>> = {};
  for (const row of rows) {
    rules[String(row.rule_code) as RuleCode] = {
      name: String(row.name),
      enabled: Number(row.enabled) === 1,
      config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
    };
  }
  return { version, rules };
}

export interface RuleUpdate {
  ruleCode: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Apply partial rule updates; bumps the global version in one transaction. */
export function updateRules(
  db: DatabaseSync,
  updates: RuleUpdate[],
  updatedBy: string,
): number {
  const snapshot = loadRuleSnapshot(db);
  const known = new Set<string>(RULE_ORDER);
  for (const update of updates) {
    if (!known.has(update.ruleCode)) {
      throw new Error(`未知规则: ${update.ruleCode}`);
    }
  }
  const newVersion = snapshot.version + 1;
  const stamp = nowIso();
  for (const update of updates) {
    const code = update.ruleCode as RuleCode;
    const current = snapshot.rules[code];
    if (!current) throw new Error(`规则配置缺失: ${code}`);
    const enabled = update.enabled !== undefined ? update.enabled : current.enabled;
    let config = current.config;
    if (update.config) {
      config = { ...current.config, ...update.config };
      validateConfig(code, config);
    }
    run(
      db,
      `UPDATE approval_rules
       SET enabled = ?, config_json = ?, version = ?, updated_by = ?, updated_at = ?
       WHERE rule_code = ?`,
      enabled ? 1 : 0,
      canonicalJson(config),
      newVersion,
      updatedBy,
      stamp,
      code,
    );
  }
  run(
    db,
    'UPDATE approval_rules SET version = ?, updated_by = ?, updated_at = ?',
    newVersion,
    updatedBy,
    stamp,
  );
  return newVersion;
}

export function resetRules(db: DatabaseSync, updatedBy: string): number {
  const snapshot = loadRuleSnapshot(db);
  const newVersion = snapshot.version + 1;
  const stamp = nowIso();
  for (const code of RULE_ORDER) {
    const spec = DEFAULT_RULES[code];
    run(
      db,
      `UPDATE approval_rules
       SET name = ?, enabled = ?, config_json = ?, version = ?, updated_by = ?, updated_at = ?
       WHERE rule_code = ?`,
      spec.name,
      spec.enabled ? 1 : 0,
      canonicalJson(spec.config),
      newVersion,
      updatedBy,
      stamp,
      code,
    );
  }
  return newVersion;
}

function validateConfig(code: RuleCode, config: Record<string, unknown>): void {
  const rules: Partial<Record<RuleCode, () => void>> = {
    LEAVE_TYPE_ALLOWED: () => {
      const allowed = config.allowedTypes;
      if (!Array.isArray(allowed) || allowed.length === 0) {
        throw new Error('allowedTypes 必须是非空列表');
      }
    },
    REASON_COMPLETE: () => {
      const minimum = Number(config.minLength ?? 8);
      const maximum = Number(config.maxLength ?? 200);
      if (!(minimum >= 4 && minimum <= maximum && maximum <= 500)) {
        throw new Error('原因长度阈值不合法');
      }
    },
    FUTURE_REQUEST: () => {
      if (Number(config.minLeadMinutes ?? 120) < 0) throw new Error('提前时长不能为负');
    },
    DATE_RANGE_ALLOWED: () => {
      if (Number(config.maxFutureDays ?? 30) < 1) throw new Error('申请区间阈值不合法');
    },
    DURATION_LIMIT: () => {
      const maximum = Number(config.maxMinutes ?? 480);
      if (!(maximum >= 1 && maximum <= 43200)) throw new Error('时长上限不合法');
    },
    FREQUENCY_LIMIT: () => {
      if (Number(config.maxCount ?? 3) < 1) throw new Error('次数上限不合法');
      if (Number(config.maxTotalMinutes ?? 1440) < 60) throw new Error('累计时长上限不合法');
    },
  };
  rules[code]?.();
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

export interface EvaluateInput {
  studentRow: Row;
  leaveType: string;
  startIso: string;
  endIso: string;
  start: Date;
  end: Date;
  reason: string;
  submittedAt: Date;
  leaveRequestId: string;
  snapshot?: RuleSnapshot;
}

/** Run all enabled rules; degrade to manual_review on any engine error. */
export function evaluate(db: DatabaseSync, input: EvaluateInput): Evaluation {
  const snapshot = input.snapshot ?? loadRuleSnapshot(db);
  const ctx: RuleContext = {
    db,
    studentRow: input.studentRow,
    studentId: String(input.studentRow.id ?? ''),
    leaveType: input.leaveType,
    startIso: input.startIso,
    endIso: input.endIso,
    start: input.start,
    end: input.end,
    reason: input.reason,
    submittedAt: input.submittedAt,
    leaveRequestId: input.leaveRequestId,
  };
  const results: RuleResult[] = [];
  let errorCode: string | null = null;
  let outcome: 'approved_auto' | 'manual_review';
  try {
    for (const code of RULE_ORDER) {
      const spec = snapshot.rules[code];
      if (!spec) throw new Error(`规则配置缺失: ${code}`);
      if (!spec.enabled) continue;
      results.push(RULE_CHECKS[code](ctx, spec.config));
    }
    outcome = results.every((result) => result.passed) ? 'approved_auto' : 'manual_review';
  } catch {
    // protective degradation, plan section 9
    errorCode = 'ENGINE_ERROR';
    outcome = 'manual_review';
  }
  return {
    outcome,
    version: snapshot.version,
    results,
    errorCode,
    evaluatedAt: nowIso(),
  };
}

export function persistEvaluation(
  db: DatabaseSync,
  leaveRequestId: string,
  evaluation: Evaluation,
): string {
  const evaluationId = shortId('EV');
  run(
    db,
    `INSERT INTO leave_rule_evaluations
      (id, leave_request_id, rule_version, outcome, evaluated_at, error_code)
     VALUES (?, ?, ?, ?, ?, ?)`,
    evaluationId,
    leaveRequestId,
    evaluation.version,
    evaluation.outcome,
    evaluation.evaluatedAt,
    evaluation.errorCode,
  );
  evaluation.results.forEach((result, index) => {
    run(
      db,
      `INSERT INTO leave_rule_results
        (evaluation_id, rule_code, passed, actual_json, expected_json, message, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      evaluationId,
      result.ruleCode,
      result.passed ? 1 : 0,
      canonicalJson(result.actual),
      canonicalJson(result.expected),
      result.message,
      index + 1,
    );
  });
  return evaluationId;
}

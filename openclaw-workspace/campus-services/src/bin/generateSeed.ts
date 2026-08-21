#!/usr/bin/env node
/**
 * Deterministic demo seed generator (plan sections 13 / 20.6).
 *
 * GLM-authored material pools (colleges, majors, names, reasons) are
 * assembled by a seeded PRNG, and every candidate leave is verified against
 * the REAL approval engine anchored at its own submittedAt — so declared
 * statuses can never contradict the evaluation evidence that importDemoSeed
 * re-checks on import.
 *
 * Output: demo/auto-approval/seed/{school,colleges,classes,students,
 * leave-requests}.json
 * Quotas (plan 13.2): 600 leaves — auto 210 / manual 150 / approved-manual
 * 120 / rejected 60 / cancelled 60; types sick 270 / personal 210 /
 * official 60 / other 60; >=45 overlap pairs, >=50 students with 3+
 * approved leaves in 30 days, >=50 short-lead requests, placeholder
 * reasons included.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { evaluate } from '../approvalEngine.ts';
import { openDatabase, parseDateTime, run, withTransaction } from '../db.ts';
import { seedDemoBase } from '../seed.ts';

const DAY_MS = 86_400_000;
const ANCHOR_ISO = '2026-08-18T08:00:00+08:00';

// ---------------------------------------------------------------------------
// deterministic PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// GLM-authored material pools (fictional demo content only)
// ---------------------------------------------------------------------------

const COLLEGE_POOLS: Array<{ code: string; name: string; majors: string[] }> = [
  { code: 'CSAI', name: '计算机与人工智能学院', majors: ['软件工程', '人工智能', '数据科学', '物联网工程'] },
  { code: 'INFO', name: '信息工程学院', majors: ['通信工程', '电子信息工程', '网络工程', '微电子科学'] },
  { code: 'MECH', name: '智能装备学院', majors: ['机械工程', '自动化', '工业设计', '车辆工程'] },
  { code: 'HUMA', name: '人文学院', majors: ['汉语言文学', '新闻学', '历史学', '哲学'] },
  { code: 'FOREIGN', name: '外国语学院', majors: ['英语', '日语', '法语', '翻译'] },
  { code: 'ECON', name: '经济管理学院', majors: ['金融学', '会计学', '国际经济与贸易', '工商管理'] },
];

const SURNAMES = ['林', '周', '陈', '吴', '郑', '王', '赵', '孙', '钱', '李', '张', '刘', '杨', '黄', '徐', '朱', '高', '马', '罗', '梁'];

const REASONS: Record<'sick' | 'personal' | 'official' | 'other', string[]> = {
  sick: [
    '发烧身体不适，需要前往校医院就诊并休息观察',
    '肠胃炎发作，需要休息服药并观察半天情况',
    '感冒头痛，前往校医院开药后需静养恢复',
    '牙痛难忍，需要前往口腔科做进一步治疗',
    '运动时不慎扭伤脚踝，需要到医务室处理并静养',
    '眼部不适需要去医院复查视力并按医嘱休息',
    '扁桃体发炎引起低烧，需要输液治疗观察',
    '皮肤过敏需要就医处理，并避免剧烈活动',
    '偏头痛反复发作，需要前往医院检查并休息',
    '智齿发炎肿痛，需要预约拔牙并术后休息',
  ],
  personal: [
    '家中有急事需要回老家一趟处理相关事务',
    '需要前往银行网点办理个人重要业务手续',
    '参加亲属婚礼，需要请假返回家中帮忙筹备',
    '身份证件即将到期，需要前往政务中心补办',
    '房屋租赁合同到期，需要与房东当面交接核对',
    '需要参加校外职业资格证书统一考试',
    '需要陪同家人前往医院进行复诊检查',
    '办理护照需要按预约时间到现场采集信息',
    '参加校内勤工俭学岗位的校外培训安排',
    '处理个人学籍档案转递手续需要现场确认',
  ],
  official: [
    '代表学校参加省级程序设计竞赛联合集训活动',
    '参加校际辩论联赛决赛阶段的集中备赛',
    '随院队前往外地参加大学生数学建模竞赛',
    '参加校级运动会开幕式方阵排练与筹备工作',
    '受邀参加市教育局组织的青年学生论坛活动',
  ],
  other: [
    '参加校外志愿服务日活动需要全天在外服务',
    '参加社区公益服务活动，需要下午时间段外出',
    '处理个人重要证件补办事宜，需要外出办理',
    '参与母校回访宣讲活动，需要按计划返校交流',
  ],
};

// placeholder-style reasons: >=4 chars to satisfy the DB length CHECK, and
// they fail REASON_COMPLETE through the pure-repeated-characters branch
const PLACEHOLDER_REASONS = ['无无无无', '测试测试测试测试'];

const REJECT_REASONS = [
  '证明材料不足，请补充后重新申请',
  '请假时段与课程考试冲突，建议调整时间',
  '近期请假频次较高，请先与辅导员当面沟通',
  '请假事由说明不够充分，暂不同意本次申请',
];

const APPROVE_REASONS = [
  '情况属实，同意请假',
  '材料齐全，已核实，同意外出',
  '已与辅导员核实情况，同意本次申请',
];

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type SeedLeaveType = 'sick' | 'personal' | 'official' | 'other';
export type SeedLeaveStatus = 'approved_auto' | 'manual_review' | 'approved_manual' | 'rejected_manual' | 'cancelled';

export interface SeedLeaveRecord {
  id: string;
  studentNo: string;
  leaveType: SeedLeaveType;
  startAt: string;
  endAt: string;
  reason: string;
  submittedAt: string;
  status: SeedLeaveStatus;
  decisionMode: 'auto' | 'manual' | null;
  decidedAt: string | null;
  decisionReason: string | null;
  source: 'seed';
}

export interface SeedStructure {
  colleges: Array<Record<string, unknown>>;
  classes: Array<Record<string, unknown>>;
  students: Array<Record<string, unknown>>;
}

export interface SeedQuotas {
  leaves: number;
  auto: number;
  manual: number;
  approvedManual: number;
  rejected: number;
  cancelled: number;
  shortLead: number;
  overlapPairs: number;
  busyStudents: number;
  placeholderReasons: number;
}

export interface GenerateSeedResult {
  structure: SeedStructure;
  leaves: SeedLeaveRecord[];
  quotas: SeedQuotas;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isoPlus8(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60_000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

function dayKeyOf(date: Date): string {
  return isoPlus8(date).slice(0, 10);
}

function buildStructure(): { structure: SeedStructure; studentNos: string[] } {
  const colleges: Array<Record<string, unknown>> = [];
  const classes: Array<Record<string, unknown>> = [];
  const students: Array<Record<string, unknown>> = [];
  const studentNos: string[] = [];
  COLLEGE_POOLS.forEach((college, collegeIndex) => {
    const collegeId = `COLLEGE-${college.code}`;
    colleges.push({
      id: collegeId,
      schoolId: 'SCH-YUNCHUAN',
      code: college.code,
      name: college.name,
      status: 'active',
      createdAt: '2026-01-10T09:00:00+08:00',
      updatedAt: '2026-01-10T09:00:00+08:00',
    });
    for (let grade = 2023; grade <= 2026; grade += 1) {
      const gradeSeq = grade - 2023;
      const classCode = `${college.code}-${String(grade).slice(2)}${String(gradeSeq + 1).padStart(2, '0')}`;
      const classId = `CLASS-${classCode}`;
      classes.push({
        id: classId,
        collegeId,
        code: classCode,
        name: `${college.majors[gradeSeq]} ${String(grade).slice(2)}${String(gradeSeq + 1).padStart(2, '0')} 班`,
        gradeYear: grade,
        majorName: college.majors[gradeSeq],
        status: 'active',
        createdAt: '2026-01-10T09:00:00+08:00',
        updatedAt: '2026-01-10T09:00:00+08:00',
      });
      for (let seq = 1; seq <= 20; seq += 1) {
        const studentNo = `${grade}${String(collegeIndex + 1).padStart(2, '0')}${String(gradeSeq + 1).padStart(2, '0')}${String(seq).padStart(2, '0')}`;
        students.push({
          studentNo,
          name: `${SURNAMES[seq - 1]}同学`,
          collegeId,
          classId,
          enrollmentYear: grade,
          status: 'active',
          createdAt: '2026-01-15T09:00:00+08:00',
          updatedAt: '2026-01-15T09:00:00+08:00',
        });
        studentNos.push(studentNo);
      }
    }
  });
  return { structure: { colleges, classes, students }, studentNos };
}

// ---------------------------------------------------------------------------
// generator
// ---------------------------------------------------------------------------

export function generateSeedIntoDb(
  db: DatabaseSync,
  options: { seed?: number; anchorIso?: string } = {},
): GenerateSeedResult {
  const random = mulberry32(options.seed ?? 20260818);
  const anchor = parseDateTime(options.anchorIso ?? ANCHOR_ISO, '锚点时间');
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T;
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  const { structure, studentNos } = buildStructure();

  withTransaction(db, () => {
    seedDemoBase(db); // keeps default approval rules + demo baseline school
    run(
      db,
      `INSERT OR REPLACE INTO schools (id, name, timezone, status, created_at, updated_at)
       VALUES ('SCH-YUNCHUAN', '云川大学', 'Asia/Shanghai', 'active', '2026-01-10T09:00:00+08:00', '2026-01-10T09:00:00+08:00')`,
    );
    for (const college of structure.colleges) {
      run(
        db,
        `INSERT OR REPLACE INTO colleges (id, school_id, code, name, status, created_at, updated_at)
         VALUES (?, 'SCH-YUNCHUAN', ?, ?, 'active', ?, ?)`,
        college.id,
        college.code,
        college.name,
        college.createdAt,
        college.updatedAt,
      );
    }
    for (const klass of structure.classes) {
      run(
        db,
        `INSERT OR REPLACE INTO classes
           (id, college_id, code, name, grade_year, major_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        klass.id,
        klass.collegeId,
        klass.code,
        klass.name,
        klass.gradeYear,
        klass.majorName,
        klass.createdAt,
        klass.updatedAt,
      );
    }
    for (const student of structure.students) {
      run(
        db,
        `INSERT OR REPLACE INTO students
           (id, student_no, name, college_id, class_id, enrollment_year, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        student.studentNo,
        student.studentNo,
        student.name,
        student.collegeId,
        student.classId,
        student.enrollmentYear,
        student.createdAt,
        student.updatedAt,
      );
    }
  });

  // ---- leave assembly ---------------------------------------------------
  const TOTAL = 600;
  const QUOTA = {
    auto: 210,
    manual: 150,
    approvedManual: 120,
    rejected: 60,
    cancelled: 60,
    overlapPairs: 45,
    shortLead: 50,
    busyStudents: 50,
  } as const;

  const records: SeedLeaveRecord[] = [];
  const activeIntervals = new Map<string, Array<{ start: number; end: number }>>();
  let overlapPairs = 0;
  let shortLeadCount = 0;
  let sequence = 0;
  let autoCursor = 0;

  const studentRowCache = new Map<string, Record<string, unknown>>();
  const studentRow = (studentNo: string) => {
    let row = studentRowCache.get(studentNo);
    if (!row) {
      row = db.prepare('SELECT * FROM students WHERE student_no = ?').get(studentNo) as Record<string, unknown>;
      studentRowCache.set(studentNo, row);
    }
    return row;
  };

  const hasActiveOverlap = (studentNo: string, start: number, end: number) =>
    (activeIntervals.get(studentNo) ?? []).some(
      (interval) => interval.start < end && interval.end > start,
    );

  const registerActive = (studentNo: string, start: number, end: number) => {
    const intervals = activeIntervals.get(studentNo) ?? [];
    if (intervals.some((interval) => interval.start < end && interval.end > start)) {
      overlapPairs += 1;
    }
    intervals.push({ start, end });
    activeIntervals.set(studentNo, intervals);
  };

  /** Insert candidate, run the real engine, and finalize to `desired`.
   * Returns null (and removes the row) when the engine outcome does not
   * support the declared status — the caller retries with another slot. */
  const tryCommit = (
    studentNo: string,
    type: SeedLeaveType,
    submitted: Date,
    start: Date,
    end: Date,
    reason: string,
    desired: SeedLeaveStatus,
  ): SeedLeaveRecord | null => {
    sequence += 1;
    const id = `LV${dayKeyOf(submitted).replace(/-/g, '')}-${String(sequence).padStart(6, '0')}`;
    run(
      db,
      `INSERT INTO leave_requests
         (id, student_id, leave_type, start_at, end_at, reason, status, source,
          submitted_at, row_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'evaluating', 'seed', ?, 1, ?, ?)`,
      id,
      studentNo,
      type,
      isoPlus8(start),
      isoPlus8(end),
      reason,
      isoPlus8(submitted),
      isoPlus8(submitted),
      isoPlus8(submitted),
    );
    const evaluation = evaluate(db, {
      studentRow: studentRow(studentNo),
      leaveType: type,
      startIso: isoPlus8(start),
      endIso: isoPlus8(end),
      start,
      end,
      reason,
      submittedAt: submitted,
      leaveRequestId: id,
    });
    const engineAuto = evaluation.outcome === 'approved_auto';
    if (desired === 'approved_auto' ? !engineAuto : engineAuto) {
      run(db, 'DELETE FROM leave_requests WHERE id = ?', id);
      sequence -= 1;
      return null;
    }

    let decidedAt: Date | null = null;
    let decisionMode: 'auto' | 'manual' | null = null;
    let decisionReason: string | null = null;
    if (desired === 'approved_auto') {
      decidedAt = submitted;
      decisionMode = 'auto';
      decisionReason = `全部 ${evaluation.results.filter((item) => item.passed).length} 项低风险规则通过（规则版本 ${evaluation.version}）`;
    } else if (desired === 'approved_manual' || desired === 'rejected_manual') {
      decidedAt = new Date(submitted.getTime() + between(1, 36) * 3_600_000);
      decisionMode = 'manual';
      decisionReason = desired === 'approved_manual' ? pick(APPROVE_REASONS) : pick(REJECT_REASONS);
    } else if (desired === 'cancelled') {
      decidedAt = new Date(submitted.getTime() + between(20, 180) * 60_000);
      if (decidedAt.getTime() >= start.getTime()) decidedAt = new Date(start.getTime() - 60_000);
    }
    run(
      db,
      `UPDATE leave_requests
       SET status = ?, decided_at = ?, decision_mode = ?, decision_reason = ?, updated_at = ?
       WHERE id = ?`,
      desired,
      decidedAt ? isoPlus8(decidedAt) : null,
      decisionMode,
      decisionReason,
      isoPlus8(decidedAt ?? submitted),
      id,
    );

    const record: SeedLeaveRecord = {
      id,
      studentNo,
      leaveType: type,
      startAt: isoPlus8(start),
      endAt: isoPlus8(end),
      reason,
      submittedAt: isoPlus8(submitted),
      status: desired,
      decisionMode,
      decidedAt: decidedAt ? isoPlus8(decidedAt) : null,
      decisionReason,
      source: 'seed',
    };
    records.push(record);
    if (desired !== 'cancelled' && desired !== 'rejected_manual') {
      registerActive(studentNo, start.getTime(), end.getTime());
    }
    if (start.getTime() - submitted.getTime() < 2 * 3_600_000) {
      shortLeadCount += 1;
    }
    return record;
  };

  // candidate builders -----------------------------------------------------
  const buildAutoCandidate = (submitted: Date, type: 'sick' | 'personal') => {
    const start = new Date(submitted.getTime() + between(3, 8) * 3_600_000);
    if (dayKeyOf(start) !== dayKeyOf(submitted)) return null;
    const end = new Date(start.getTime() + between(60, 420) * 60_000);
    if (dayKeyOf(end) !== dayKeyOf(start)) return null;
    return { start, end, reason: pick(REASONS[type]) };
  };

  type FailingStyle = 'short-lead' | 'cross-day' | 'long-hours' | 'far-future' | 'as-is' | 'overlapping';
  const buildFailingCandidate = (
    submitted: Date,
    type: SeedLeaveType,
    style: FailingStyle,
  ): { start: Date; end: Date; reason: string } => {
    switch (style) {
      case 'short-lead': {
        const start = new Date(submitted.getTime() + between(15, 110) * 60_000);
        const end = new Date(start.getTime() + between(60, 300) * 60_000);
        return { start, end: dayKeyOf(end) === dayKeyOf(start) ? end : new Date(start.getTime() + 60 * 60_000), reason: pick(REASONS[type]) };
      }
      case 'cross-day': {
        const start = new Date(submitted.getTime() + between(18, 26) * 3_600_000);
        const end = new Date(start.getTime() + between(12, 30) * 3_600_000);
        return { start, end, reason: pick(REASONS[type]) };
      }
      case 'long-hours': {
        const start = new Date(submitted.getTime() + between(18, 22) * 3_600_000);
        return { start, end: new Date(start.getTime() + 9 * 3_600_000), reason: pick(REASONS[type]) };
      }
      case 'far-future': {
        const start = new Date(submitted.getTime() + between(32, 55) * DAY_MS);
        return { start, end: new Date(start.getTime() + between(2, 6) * 3_600_000), reason: pick(REASONS[type]) };
      }
      default: {
        // as-is: healthy-looking; caller ensures a rule fails another way
        // (type official/other, overlap, or frequency)
        const start = new Date(submitted.getTime() + between(3, 8) * 3_600_000);
        const end = new Date(start.getTime() + between(60, 420) * 60_000);
        return { start, end, reason: pick(REASONS[type]) };
      }
    }
  };

  // status/type plans (deterministic shuffle) -------------------------------
  const typePlan: SeedLeaveType[] = [
    ...Array.from({ length: 270 }, () => 'sick' as SeedLeaveType),
    ...Array.from({ length: 210 }, () => 'personal' as SeedLeaveType),
    ...Array.from({ length: 60 }, () => 'official' as SeedLeaveType),
    ...Array.from({ length: 60 }, () => 'other' as SeedLeaveType),
  ];
  const shuffle = <T>(list: T[]) => {
    for (let index = list.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [list[index], list[swap]] = [list[swap]!, list[index]!];
    }
    return list;
  };
  shuffle(typePlan);

  // 1) busy clusters: 50 students × (3 auto + 1 admin-approved) inside 30 days
  const busyStudents = studentNos.slice(0, QUOTA.busyStudents);
  for (const studentNo of busyStudents) {
    const clusterAnchor = anchor.getTime() - between(35, 70) * DAY_MS;
    for (let leave = 0; leave < 4; leave += 1) {
      const submitted = new Date(clusterAnchor + leave * 6 * DAY_MS);
      submitted.setHours(between(8, 10), between(0, 50), 0, 0);
      const desired: SeedLeaveStatus = leave < 3 ? 'approved_auto' : 'approved_manual';
      const type: 'sick' | 'personal' = leave % 2 === 0 ? 'sick' : 'personal';
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const useFailingShape = desired === 'approved_manual' || attempt >= 12;
        const candidate = useFailingShape
          ? buildFailingCandidate(submitted, type, leave === 3 ? 'cross-day' : 'short-lead')
          : buildAutoCandidate(submitted, type);
        if (!candidate) continue;
        if (
          desired === 'approved_auto' &&
          hasActiveOverlap(studentNo, candidate.start.getTime(), candidate.end.getTime())
        ) {
          continue;
        }
        // the 4th leave intentionally keeps overlapping-free hours when
        // possible so only FREQUENCY_LIMIT decides its fate
        if (tryCommit(studentNo, type, submitted, candidate.start, candidate.end, candidate.reason, desired)) {
          break;
        }
      }
    }
  }

  // 2) the remaining timeline, oldest-first so history grows realistically.
  // The busy clusters above already delivered part of the quota, so the
  // main loop consumes the RESIDUAL per-status targets from a dynamic pool:
  // a status that cannot land in this slot goes back into the pool and a
  // different status takes the slot, keeping totals and quotas exact.
  const countStatus = (status: SeedLeaveStatus) =>
    records.filter((item) => item.status === status).length;
  const statusPool: SeedLeaveStatus[] = shuffle([
    ...Array.from({ length: Math.max(0, QUOTA.auto - countStatus('approved_auto')) }, () => 'approved_auto' as SeedLeaveStatus),
    ...Array.from({ length: Math.max(0, QUOTA.manual - countStatus('manual_review')) }, () => 'manual_review' as SeedLeaveStatus),
    ...Array.from({ length: Math.max(0, QUOTA.approvedManual - countStatus('approved_manual')) }, () => 'approved_manual' as SeedLeaveStatus),
    ...Array.from({ length: Math.max(0, QUOTA.rejected - countStatus('rejected_manual')) }, () => 'rejected_manual' as SeedLeaveStatus),
    ...Array.from({ length: Math.max(0, QUOTA.cancelled - countStatus('cancelled')) }, () => 'cancelled' as SeedLeaveStatus),
  ]);
  const remaining = TOTAL - records.length;
  while (statusPool.length > remaining) statusPool.pop();
  while (statusPool.length < remaining) statusPool.push('manual_review');
  // type pools: auto needs sick/personal; filler types are consumed first by
  // manual-family records so the 270/210/60/60 distribution still lands
  const autoTypePool = shuffle(typePlan.filter((type) => type === 'sick' || type === 'personal'));
  const fillerTypePool = shuffle(typePlan.filter((type) => type === 'official' || type === 'other'));
  const takeType = (status: SeedLeaveStatus): SeedLeaveType => {
    if (status === 'approved_auto') return autoTypePool.pop() ?? 'sick';
    if (fillerTypePool.length > 0) return fillerTypePool.pop()!;
    return autoTypePool.pop() ?? 'personal';
  };
  const returnType = (type: SeedLeaveType) => {
    if (type === 'official' || type === 'other') fillerTypePool.push(type);
    else autoTypePool.unshift(type);
  };

  for (let index = 0; index < remaining; index += 1) {
    const dayBack = Math.round(((remaining - index) / remaining) * 88);
    const submitted = new Date(anchor.getTime() - dayBack * DAY_MS);
    submitted.setHours(between(8, 20), between(0, 55), 0, 0);

    let desired: SeedLeaveStatus | undefined = statusPool.shift();
    let type = desired ? takeType(desired) : 'sick';
    let placed = false;
    let swapGuard = 0;
    while (!placed && desired && swapGuard < 8) {
      swapGuard += 1;
      for (let attempt = 0; attempt < 60 && !placed; attempt += 1) {
      // approved_auto slots rotate through all students so frequency-capped
      // ones fail fast instead of burning retries; other statuses stay random
      const studentNo =
        desired === 'approved_auto'
          ? studentNos[autoCursor++ % studentNos.length]!
          : studentNos[Math.floor(random() * studentNos.length)]!;
      if (desired === 'approved_auto') {
        if (type !== 'sick' && type !== 'personal') continue;
        const candidate = buildAutoCandidate(submitted, type);
        if (!candidate) continue;
        if (hasActiveOverlap(studentNo, candidate.start.getTime(), candidate.end.getTime())) continue;
        placed =
          tryCommit(studentNo, type, submitted, candidate.start, candidate.end, candidate.reason, desired) !== null;
        continue;
      }
      // manual-family: force at least one failing rule
      let style: FailingStyle = (['as-is', 'cross-day', 'long-hours', 'far-future', 'as-is'] as FailingStyle[])[attempt % 5]!;
      if (shortLeadCount < QUOTA.shortLead && attempt % 4 === 1) style = 'short-lead';
      let candidate = buildFailingCandidate(submitted, type, style);
      if (type !== 'official' && type !== 'other' && style === 'as-is') {
        // 'as-is' with sick/personal only fails via overlap/frequency; force
        // overlap when the quota still wants pairs, otherwise cross the day
        if (overlapPairs < QUOTA.overlapPairs) {
          const interval = (activeIntervals.get(studentNo) ?? [])[0];
          if (interval) {
            const start = new Date(interval.start + 30 * 60_000);
            const end = new Date(Math.min(interval.end - 5 * 60_000, start.getTime() + 3 * 3_600_000));
            if (end > start) {
              candidate = { start, end, reason: pick(REASONS[type]) };
            }
          }
        } else {
          candidate = buildFailingCandidate(submitted, type, 'cross-day');
        }
      }
      if (type === 'official' || type === 'other') {
        // LEAVE_TYPE_ALLOWED already fails; keep a same-day shape for variety
        if (style !== 'short-lead' && attempt % 3 === 0) {
          const start = new Date(submitted.getTime() + between(3, 8) * 3_600_000);
          candidate = { start, end: new Date(start.getTime() + between(60, 420) * 60_000), reason: pick(REASONS[type]) };
        }
      }
        placed =
          tryCommit(studentNo, type, submitted, candidate.start, candidate.end, candidate.reason, desired) !== null;
      }
      if (!placed) {
        // this status cannot land in this slot: return it to the pool and
        // let a different status take the slot
        statusPool.push(desired);
        returnType(type);
        const next: SeedLeaveStatus | undefined = statusPool.shift();
        if (!next || next === desired) break;
        desired = next;
        type = takeType(desired);
      }
    }
    if (!placed && desired) {
      // guaranteed fallback: official always fails LEAVE_TYPE_ALLOWED
      if (type !== 'official' && type !== 'other') returnType(type);
      const studentNo = studentNos[Math.floor(random() * studentNos.length)]!;
      const candidate = buildFailingCandidate(submitted, 'official', 'as-is');
      tryCommit(studentNo, 'official', submitted, candidate.start, candidate.end, candidate.reason, desired === 'approved_auto' ? 'approved_manual' : desired);
    }
  }

  // 3) placeholder reasons on 8 pending manual records
  let placeholderCount = 0;
  for (const record of records) {
    if (placeholderCount >= 8) break;
    if (record.status !== 'manual_review') continue;
    if (parseDateTime(record.startAt, '开始时间').getTime() - parseDateTime(record.submittedAt, '提交时间').getTime() < 2 * 3_600_000) {
      continue; // keep short-lead records with real reasons
    }
    const placeholder = PLACEHOLDER_REASONS[placeholderCount % PLACEHOLDER_REASONS.length]!;
    record.reason = placeholder;
    run(db, 'UPDATE leave_requests SET reason = ? WHERE id = ?', placeholder, record.id);
    placeholderCount += 1;
  }

  // busy-student recount from the committed records
  const busyReached = new Set<string>();
  for (const studentNo of busyStudents) {
    const times = records
      .filter(
        (item) =>
          item.studentNo === studentNo &&
          (item.status === 'approved_auto' || item.status === 'approved_manual'),
      )
      .map((item) => parseDateTime(item.submittedAt, '提交时间').getTime())
      .sort((a, b) => a - b);
    for (let index = 2; index < times.length; index += 1) {
      if (times[index]! - times[index - 2]! <= 30 * DAY_MS) {
        busyReached.add(studentNo);
        break;
      }
    }
  }

  return {
    structure,
    leaves: records,
    quotas: {
      leaves: records.length,
      auto: records.filter((item) => item.status === 'approved_auto').length,
      manual: records.filter((item) => item.status === 'manual_review').length,
      approvedManual: records.filter((item) => item.status === 'approved_manual').length,
      rejected: records.filter((item) => item.status === 'rejected_manual').length,
      cancelled: records.filter((item) => item.status === 'cancelled').length,
      shortLead: shortLeadCount,
      overlapPairs,
      busyStudents: busyReached.size,
      placeholderReasons: placeholderCount,
    },
  };
}

// ---------------------------------------------------------------------------
// output + CLI
// ---------------------------------------------------------------------------

export function writeSeedFiles(outputDir: string, result: GenerateSeedResult): void {
  mkdirSync(outputDir, { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(
    join(outputDir, 'school.json'),
    json([
      {
        id: 'SCH-YUNCHUAN',
        name: '云川大学',
        timezone: 'Asia/Shanghai',
        status: 'active',
        createdAt: '2026-01-10T09:00:00+08:00',
        updatedAt: '2026-01-10T09:00:00+08:00',
      },
    ]),
    'utf8',
  );
  writeFileSync(join(outputDir, 'colleges.json'), json(result.structure.colleges), 'utf8');
  writeFileSync(join(outputDir, 'classes.json'), json(result.structure.classes), 'utf8');
  writeFileSync(join(outputDir, 'students.json'), json(result.structure.students), 'utf8');
  writeFileSync(join(outputDir, 'leave-requests.json'), json(result.leaves), 'utf8');
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
  const outputDir = resolve(process.argv[2] ?? 'demo/auto-approval/seed');
  const db = openDatabase(':memory:');
  try {
    const result = generateSeedIntoDb(db);
    writeSeedFiles(outputDir, result);
    process.stdout.write(
      `${JSON.stringify({ ok: true, action: 'generate-seed', outputDir, quotas: result.quotas })}\n`,
    );
  } finally {
    db.close();
  }
}

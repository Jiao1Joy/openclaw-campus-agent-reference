// ============================================================
// 校园管理端 - 数据类型（与 /api/campus-admin 服务端响应一一对应）
// ============================================================

export type LeaveStatus =
  | 'evaluating'
  | 'approved_auto'
  | 'manual_review'
  | 'approved_manual'
  | 'rejected_manual'
  | 'cancelled';

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  evaluating: '审批中',
  approved_auto: '已自动批准',
  manual_review: '待人工复核',
  approved_manual: '已人工批准',
  rejected_manual: '已人工驳回',
  cancelled: '已撤回',
};

export const LEAVE_STATUS_OPTIONS: Array<{ value: LeaveStatus; label: string }> = [
  { value: 'manual_review', label: '待人工复核' },
  { value: 'approved_auto', label: '已自动批准' },
  { value: 'approved_manual', label: '已人工批准' },
  { value: 'rejected_manual', label: '已人工驳回' },
  { value: 'cancelled', label: '已撤回' },
];

export type LeaveTypeCode = 'sick' | 'personal' | 'official' | 'other';

export const LEAVE_TYPE_LABELS: Record<LeaveTypeCode, string> = {
  sick: '病假',
  personal: '事假',
  official: '公假',
  other: '其他',
};

export const LEAVE_TYPE_OPTIONS: Array<{ value: LeaveTypeCode; label: string }> = [
  { value: 'sick', label: '病假' },
  { value: 'personal', label: '事假' },
  { value: 'official', label: '公假' },
  { value: 'other', label: '其他' },
];

export interface AdminLoginResponse {
  ok: true;
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
  expiresIn: number;
  principal: { username: string; displayName: string; roles: string[] };
}

export interface AdminSessionResponse {
  authenticated: true;
  principal: { username: string; displayName: string; roles: string[] };
}

export interface DashboardMetrics {
  pendingManual: number;
  todaySubmitted: number;
  autoApproved: number;
  manualApproved: number;
  manualRejected: number;
  cancelled: number;
  totalRequests: number;
  autoApproveRate: number | null;
}

export interface DashboardTrendDay {
  date: string;
  submitted: number;
  approvedAuto: number;
  manualApproved: number;
  manualRejected: number;
}

export interface DashboardResponse {
  ok: true;
  metrics: DashboardMetrics;
  trend: DashboardTrendDay[];
}

export interface LeaveListItem {
  id: string;
  studentNo: string;
  studentName: string;
  studentStatus: string;
  collegeName: string;
  className: string;
  leaveType: LeaveTypeCode;
  leaveTypeLabel: string;
  startAt: string;
  endAt: string;
  status: LeaveStatus;
  statusLabel: string;
  submittedAt: string;
  decidedAt: string | null;
  decisionMode: 'auto' | 'manual' | null;
  rowVersion: number;
}

export interface LeaveListResponse {
  ok: true;
  page: number;
  pageSize: number;
  total: number;
  items: LeaveListItem[];
}

export interface RuleResultView {
  ruleCode: string;
  ruleName?: string;
  passed: boolean;
  actual: Record<string, unknown> | null;
  expected: Record<string, unknown> | null;
  message: string;
}

export interface LeaveDetailView {
  request: {
    id: string;
    studentId: string;
    studentName: string;
    college: string;
    className: string;
    leaveType: string;
    start: string;
    end: string;
    reason: string;
    status: LeaveStatus;
    statusLabel: string;
    submittedAt: string;
    decidedAt: string | null;
    decisionMode: 'auto' | 'manual' | null;
    decisionSummary: string | null;
    ruleSummary: { version: number; passedCount: number; totalCount: number } | null;
    failedRules: Array<{ ruleCode: string; ruleName: string; message: string }>;
    rowVersion: number;
  };
  student: { id: string; name: string; status: string } | null;
  evaluation: {
    id: string;
    outcome: 'approved_auto' | 'manual_review';
    ruleVersion: number;
    evaluatedAt: string;
    errorCode: string | null;
  } | null;
  ruleResults: RuleResultView[];
  timeline: Array<{
    id: string;
    action: string;
    actorType: string;
    actorName: string | null;
    reason: string | null;
    fromStatus: string;
    toStatus: string;
    createdAt: string;
  }>;
  studentHistory: Array<{
    id: string;
    status: string;
    statusLabel: string;
    startAt: string;
    endAt: string;
    submittedAt: string;
    decidedAt: string | null;
  }>;
}

export interface BatchApproveResponse {
  ok: true;
  total: number;
  approved: number;
  skipped: number;
  results: Array<{
    id: string;
    ok: boolean;
    idempotent?: boolean;
    status: string | null;
    code?: string;
    message?: string;
  }>;
}

export interface SchoolRecord {
  id: string;
  name: string;
  timezone: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface CollegeRecord {
  id: string;
  schoolId: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface ClassRecord {
  id: string;
  collegeId: string;
  code: string;
  name: string;
  gradeYear: number;
  majorName: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface StudentRecord {
  id: string;
  studentNo: string;
  name: string;
  collegeId: string;
  classId: string;
  collegeName?: string;
  className?: string;
  enrollmentYear: number;
  status: 'active' | 'suspended' | 'graduated';
  createdAt: string;
  updatedAt: string;
}

export interface RuleConfigView {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface RulesResponse {
  ok: true;
  version: number;
  rules: Record<string, RuleConfigView>;
}

export interface AuditEventView {
  id: string;
  sequence: number;
  actorRef: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string | null;
  requestId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditListResponse {
  ok: true;
  page: number;
  pageSize: number;
  total: number;
  events: AuditEventView[];
}

export interface ImportSeedResponse {
  ok: true;
  action: string;
  importedLeaves: number;
  skippedLeaves: number;
  colleges: number;
  classes: number;
  students: number;
}

export const DEMO_RESET_PHRASE = 'RESET-DEMO';

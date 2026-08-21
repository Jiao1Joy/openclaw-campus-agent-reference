// ============================================================
// 校园管理端 API 客户端
// 令牌只保存在页面内存中（刷新后需重新登录，见开发方案 7.1）
// ============================================================

import type {
  AdminLoginResponse,
  AdminSessionResponse,
  AuditListResponse,
  BatchApproveResponse,
  ClassRecord,
  CollegeRecord,
  DashboardResponse,
  ImportSeedResponse,
  LeaveDetailView,
  LeaveListResponse,
  RulesResponse,
  SchoolRecord,
  StudentRecord,
} from '@/admin/types';

const API_BASE_URL = String(import.meta.env.VITE_CAMPUS_API_BASE_URL || '').replace(
  /\/$/,
  '',
);
const API_ROOT = `${API_BASE_URL}/api/campus-admin`;

let adminToken = '';

export function setAdminToken(token: string): void {
  adminToken = token;
}

export function clearAdminToken(): void {
  adminToken = '';
}

export function hasAdminToken(): boolean {
  return adminToken.length > 0;
}

// 401 时除清空令牌外还要让界面退出登录态（AdminApp 订阅此回调）
type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function onAdminUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function emitUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

function newRequestId(): string {
  return crypto.randomUUID();
}

async function request<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
    body?: unknown;
    idempotencyKey?: string;
    auth?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    'x-request-id': newRequestId(),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    headers['idempotency-key'] = options.idempotencyKey ?? newRequestId();
  }
  if (options.auth !== false && adminToken) {
    headers.authorization = `Bearer ${adminToken}`;
  }
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new AdminApiError(0, 'NETWORK_ERROR', '无法连接校园管理端服务，请确认服务是否已启动');
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    if (response.status === 401) {
      clearAdminToken();
      emitUnauthorized();
    }
    throw new AdminApiError(
      response.status,
      String(payload.code ?? 'REQUEST_FAILED'),
      String(payload.error ?? '请求失败，请稍后重试'),
    );
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// 身份
// ---------------------------------------------------------------------------

export async function adminLogin(username: string, password: string) {
  return request<AdminLoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password },
    auth: false,
  });
}

export async function getAdminSession() {
  return request<AdminSessionResponse>('/session');
}

// ---------------------------------------------------------------------------
// 概览与审批
// ---------------------------------------------------------------------------

export async function getDashboard() {
  return request<DashboardResponse>('/dashboard');
}

export async function sendAdminAssistantMessage(message: string, sessionId: string) {
  return request<{ ok: true; reply: string }>('/assistant/chat', {
    method: 'POST',
    body: { message, sessionId },
  });
}

export interface LeaveListQuery {
  status?: string;
  collegeId?: string;
  classId?: string;
  leaveType?: string;
  keyword?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export async function listLeaveRequests(query: LeaveListQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      params.set(key, String(value));
    }
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return request<LeaveListResponse>(`/leave-requests${suffix}`);
}

export async function getLeaveDetail(id: string) {
  return request<LeaveDetailView>(`/leave-requests/${encodeURIComponent(id)}`);
}

export async function approveLeave(
  id: string,
  payload: { reason?: string; rowVersion?: number },
  idempotencyKey?: string,
) {
  return request<{ ok: true; idempotent: boolean; request: { status: string } }>(
    `/leave-requests/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body: payload, idempotencyKey },
  );
}

export async function rejectLeave(
  id: string,
  payload: { reason: string; rowVersion?: number },
  idempotencyKey?: string,
) {
  return request<{ ok: true; idempotent: boolean; request: { status: string } }>(
    `/leave-requests/${encodeURIComponent(id)}/reject`,
    { method: 'POST', body: payload, idempotencyKey },
  );
}

export async function batchApproveLeaves(ids: string[], idempotencyKey?: string) {
  return request<BatchApproveResponse>('/leave-requests/batch-approve', {
    method: 'POST',
    body: { ids },
    idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// 学校数据
// ---------------------------------------------------------------------------

export async function getSchools() {
  return request<{ ok: true; schools: SchoolRecord[] }>('/school');
}

export async function patchSchool(
  payload: { id: string; name?: string; timezone?: string; status?: string },
  idempotencyKey?: string,
) {
  return request<{ ok: true }>('/school', { method: 'PATCH', body: payload, idempotencyKey });
}

export async function listColleges() {
  return request<{ ok: true; colleges: CollegeRecord[] }>('/colleges');
}

export async function createCollege(
  payload: { code: string; name: string },
  idempotencyKey?: string,
) {
  return request<{ ok: true; college: CollegeRecord }>('/colleges', {
    method: 'POST',
    body: payload,
    idempotencyKey,
  });
}

export async function patchCollege(
  payload: { id: string; name?: string; status?: string },
  idempotencyKey?: string,
) {
  return request<{ ok: true }>(`/colleges/${encodeURIComponent(payload.id)}`, {
    method: 'PATCH',
    body: payload,
    idempotencyKey,
  });
}

export async function listClasses(collegeId?: string) {
  const suffix = collegeId ? `?collegeId=${encodeURIComponent(collegeId)}` : '';
  return request<{ ok: true; classes: ClassRecord[] }>(`/classes${suffix}`);
}

export async function createClass(
  payload: {
    collegeId: string;
    code: string;
    name: string;
    majorName: string;
    gradeYear: number;
  },
  idempotencyKey?: string,
) {
  return request<{ ok: true; class: ClassRecord }>('/classes', {
    method: 'POST',
    body: payload,
    idempotencyKey,
  });
}

export async function patchClass(
  payload: { id: string; name?: string; majorName?: string; status?: string },
  idempotencyKey?: string,
) {
  return request<{ ok: true }>(`/classes/${encodeURIComponent(payload.id)}`, {
    method: 'PATCH',
    body: payload,
    idempotencyKey,
  });
}

export interface StudentListQuery {
  collegeId?: string;
  classId?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export async function listStudents(query: StudentListQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      params.set(key, String(value));
    }
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return request<{
    ok: true;
    page: number;
    pageSize: number;
    total: number;
    students: StudentRecord[];
  }>(`/students${suffix}`);
}

export async function createStudent(
  payload: {
    studentNo: string;
    name: string;
    collegeId: string;
    classId: string;
    enrollmentYear: number;
  },
  idempotencyKey?: string,
) {
  return request<{ ok: true; student: StudentRecord }>('/students', {
    method: 'POST',
    body: payload,
    idempotencyKey,
  });
}

export async function patchStudent(
  payload: {
    id: string;
    name?: string;
    status?: string;
    collegeId?: string;
    classId?: string;
  },
  idempotencyKey?: string,
) {
  return request<{ ok: true }>(`/students/${encodeURIComponent(payload.id)}`, {
    method: 'PATCH',
    body: payload,
    idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// 规则与审计
// ---------------------------------------------------------------------------

export async function getApprovalRules() {
  return request<RulesResponse>('/approval-rules');
}

export async function updateApprovalRules(
  rules: Array<{ ruleCode: string; enabled?: boolean; config?: Record<string, unknown> }>,
  idempotencyKey?: string,
) {
  return request<RulesResponse>('/approval-rules', {
    method: 'PUT',
    body: { rules },
    idempotencyKey,
  });
}

export async function resetApprovalRules(idempotencyKey?: string) {
  return request<RulesResponse>('/approval-rules/reset', {
    method: 'POST',
    idempotencyKey,
  });
}

export async function listAuditEvents(query: { action?: string; page?: number; pageSize?: number }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      params.set(key, String(value));
    }
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return request<AuditListResponse>(`/audit-events${suffix}`);
}

// ---------------------------------------------------------------------------
// Demo 工具
// ---------------------------------------------------------------------------

export async function importDemoSeed(seedDir: string, idempotencyKey?: string) {
  return request<ImportSeedResponse>('/demo/import-seed', {
    method: 'POST',
    body: { seedDir },
    idempotencyKey,
  });
}

export async function resetDemoDatabase(confirmPhrase: string, idempotencyKey?: string) {
  return request<{ ok: true; reset: true }>('/demo/reset', {
    method: 'POST',
    body: { confirmPhrase },
    idempotencyKey,
  });
}
